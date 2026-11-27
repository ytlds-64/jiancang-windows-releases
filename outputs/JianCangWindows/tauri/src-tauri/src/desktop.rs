use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{DragDropEvent, Manager, WebviewWindow, WindowEvent};

const MAX_DROP_FILE_COUNT: usize = 10_000;
const MAX_PENDING_DROPS: usize = 8;
const DROP_LIFETIME: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct FileDrop(Mutex<DropState>);

#[derive(Default)]
struct DropState {
    sequence: u64,
    pending: HashMap<u64, (Instant, Vec<PathBuf>)>,
    outgoing_file: Option<(PathBuf, Option<Instant>)>,
}

impl FileDrop {
    pub fn take(&self, sequence: u64) -> Option<Vec<PathBuf>> {
        let mut state = self.0.lock().ok()?;
        let (received, paths) = state.pending.remove(&sequence)?;
        (received.elapsed() <= DROP_LIFETIME).then_some(paths)
    }

    fn offer(&self, paths: Vec<PathBuf>) -> Value {
        if paths.len() > MAX_DROP_FILE_COUNT {
            return json!({ "tooMany": true });
        }
        let Ok(mut state) = self.0.lock() else {
            return json!({});
        };
        if paths.is_empty() {
            return json!({});
        }
        if state.outgoing_file.as_ref().is_some_and(|(file, end)| {
            end.is_none_or(|time| time.elapsed() < Duration::from_secs(1))
                && paths.len() == 1 && paths.first() == Some(file)
        }) {
            return json!({ "ignored": true });
        }
        state.pending.retain(|_, (received, _)| received.elapsed() <= DROP_LIFETIME);
        if state.pending.len() >= MAX_PENDING_DROPS {
            return json!({ "busy": true });
        }
        state.sequence += 1;
        let token = state.sequence;
        state.pending.insert(token, (Instant::now(), paths));
        json!({ "token": token })
    }

    #[cfg(windows)]
    fn begin_outgoing(&self, file: PathBuf) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "拖放状态不可用。")?;
        if matches!(state.outgoing_file, Some((_, None))) {
            return Err("已有拖出操作正在进行。".into());
        }
        state.outgoing_file = Some((file, None));
        Ok(())
    }

    #[cfg(windows)]
    fn end_outgoing(&self) {
        if let Ok(mut state) = self.0.lock() {
            if let Some((_, ending)) = state.outgoing_file.as_mut() {
                *ending = Some(Instant::now());
            }
        }
    }
}

pub fn connect_drop(window: &WebviewWindow) {
    let webview = window.clone();
    window.on_window_event(move |event| {
        let WindowEvent::DragDrop(event) = event else {
            return;
        };
        let payload = match event {
            DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
                json!({ "phase": "hover", "x": position.x, "y": position.y })
            }
            DragDropEvent::Leave => json!({ "phase": "leave" }),
            DragDropEvent::Drop { paths, position } => {
                let offer = webview.state::<FileDrop>().offer(paths.clone());
                if let Some(token) = offer["token"].as_u64() {
                    json!({ "phase": "drop", "token": token, "x": position.x, "y": position.y })
                } else {
                    json!({ "phase": "leave", "tooMany": offer["tooMany"] == true })
                }
            }
            _ => return,
        };
        let _ = webview.eval(format!(
            "window.dispatchEvent(new CustomEvent('jiancang-native-drop',{{detail:{payload}}}));"
        ));
    });
}

#[cfg(windows)]
pub fn supports_webview_file_drop() -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::CompareBrowserVersions;
    use windows::core::{w, PCWSTR};

    tauri::webview_version().ok().is_some_and(|version| {
        let version: Vec<u16> = version.encode_utf16().chain([0]).collect();
        let mut comparison = 0;
        let compared = unsafe {
            // WebView2 promoted the File WebMessage API in Runtime 113.0.1774.30.
            CompareBrowserVersions(PCWSTR(version.as_ptr()), w!("113.0.1774.30"), &mut comparison)
        };
        compared.is_ok() && comparison >= 0
    })
}

#[cfg(windows)]
pub fn connect_webview_drop(window: &WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{CoTaskMemPWSTR, WebMessageReceivedEventHandler};
    use windows::core::{Interface, PCWSTR, PWSTR};

    // Keep WebView2's DOM drop for browser data. Only the host can resolve
    // an Explorer drop's File objects to native paths for the import queue.
    let app = window.app_handle().clone();
    let _ = window.with_webview(move |platform| unsafe {
        let Ok(webview) = platform.controller().CoreWebView2() else {
            return;
        };
        let mut registration = 0;
        let _ = webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()); };
                let mut value = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut value).is_err() { return Ok(()); }
                let message = CoTaskMemPWSTR::from(value).to_string();
                let Some(request) = message.strip_prefix("jiancang-native-drop:").filter(|value| {
                    value.len() == 36 && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                }) else { return Ok(()); };
                let mut value = PWSTR::null();
                args.Source(&mut value)?;
                let source = CoTaskMemPWSTR::from(value).to_string();
                if !tauri::Url::parse(&source).ok().is_some_and(|url| crate::trusted_origin(&url)) {
                    return Ok(());
                }
                let mut result = json!({});
                if let Ok(files) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                    .and_then(|args| args.AdditionalObjects())
                {
                    let mut count = 0;
                    files.Count(&mut count)?;
                    result = if count as usize > MAX_DROP_FILE_COUNT {
                        json!({ "tooMany": true })
                    } else {
                        let (indices, paths): (Vec<_>, Vec<_>) = (0..count).filter_map(|index| {
                            let file = files.GetValueAtIndex(index).ok()?.cast::<ICoreWebView2File>().ok()?;
                            let mut value = PWSTR::null();
                            file.Path(&mut value).ok()?;
                            let path = PathBuf::from(CoTaskMemPWSTR::from(value).to_string());
                            path.is_absolute().then_some((index, path))
                        }).unzip();
                        let mut offer = app.state::<FileDrop>().offer(paths);
                        if offer["token"].is_u64() { offer["indices"] = json!(indices); }
                        offer
                    };
                }
                result["jiancangNativeDrop"] = json!(request);
                let reply: Vec<u16> = result.to_string().encode_utf16().chain([0]).collect();
                sender.PostWebMessageAsJson(PCWSTR(reply.as_ptr()))
            })),
            &mut registration,
        );
    });
}

#[cfg(windows)]
struct OleApartment;

#[cfg(windows)]
impl Drop for OleApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Ole::OleUninitialize() };
    }
}

const MAX_DRAG_PREVIEW_EDGE: i32 = 240;

pub struct DragPreview {
    width: i32,
    height: i32,
    bgra: Vec<u8>,
}

impl DragPreview {
    pub fn from_value(value: &Value) -> Option<Self> {
        let width = i32::try_from(value.get("width")?.as_u64()?).ok()?;
        let height = i32::try_from(value.get("height")?.as_u64()?).ok()?;
        if !(1..=MAX_DRAG_PREVIEW_EDGE).contains(&width)
            || !(1..=MAX_DRAG_PREVIEW_EDGE).contains(&height)
        {
            return None;
        }
        let pixels = value.get("rgba")?.as_array()?;
        let expected = (width * height * 4) as usize;
        if pixels.len() != expected {
            return None;
        }
        let mut has_alpha = false;
        let mut bgra = Vec::with_capacity(expected);
        for pixel in pixels.chunks_exact(4) {
            let byte = |channel: usize| u8::try_from(pixel[channel].as_u64()?).ok();
            let alpha = byte(3)?;
            has_alpha |= alpha > 0;
            bgra.extend_from_slice(&[byte(2)?, byte(1)?, byte(0)?, alpha]);
        }
        has_alpha.then_some(Self {
            width,
            height,
            bgra,
        })
    }
}

#[cfg(windows)]
struct DragBitmap(windows::Win32::Graphics::Gdi::HBITMAP);

#[cfg(windows)]
impl Drop for DragBitmap {
    fn drop(&mut self) {
        use windows::Win32::Graphics::Gdi::DeleteObject;
        let _ = unsafe { DeleteObject(self.0.into()) };
    }
}

#[cfg(windows)]
fn drag_bitmap(preview: &DragPreview) -> Option<(DragBitmap, windows::Win32::Foundation::SIZE)> {
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: preview.width,
            biHeight: -preview.height, // Pixel rows in the WebView buffer start at the top.
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: preview.bgra.len() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = std::ptr::null_mut();
    let bitmap = DragBitmap(unsafe {
        CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut pixels, None, 0).ok()?
    });
    if pixels.is_null() {
        return None;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(preview.bgra.as_ptr(), pixels.cast(), preview.bgra.len());
    }
    Some((
        bitmap,
        SIZE {
            cx: preview.width,
            cy: preview.height,
        },
    ))
}

#[cfg(windows)]
fn cached_drag_bitmap(
    item: &windows::Win32::UI::Shell::IShellItem,
    scale: f64,
) -> Option<(DragBitmap, windows::Win32::Foundation::SIZE)> {
    use windows::core::Interface;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{GetObjectW, BITMAP};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SIIGBF_INCACHEONLY, SIIGBF_THUMBNAILONLY,
    };
    let factory: IShellItemImageFactory = item.cast().ok()?;
    let edge = (80.0 * scale.clamp(1.0, 3.0)).round() as i32;
    let bitmap = DragBitmap(unsafe {
        factory
            .GetImage(
                SIZE { cx: edge, cy: edge },
                SIIGBF_INCACHEONLY | SIIGBF_THUMBNAILONLY,
            )
            .ok()?
    });
    let mut bits = BITMAP::default();
    let size = std::mem::size_of::<BITMAP>() as i32;
    if unsafe {
        GetObjectW(
            bitmap.0.into(),
            size,
            Some((&mut bits as *mut BITMAP).cast()),
        )
    } != size
        || !(1..=MAX_DRAG_PREVIEW_EDGE).contains(&bits.bmWidth)
        || !(1..=MAX_DRAG_PREVIEW_EDGE).contains(&bits.bmHeight)
    {
        return None;
    }
    Some((
        bitmap,
        SIZE {
            cx: bits.bmWidth,
            cy: bits.bmHeight,
        },
    ))
}

#[cfg(windows)]
fn attach_drag_preview(
    item: &windows::Win32::UI::Shell::IShellItem,
    data: &windows::Win32::System::Com::IDataObject,
    preview: Option<&DragPreview>,
    scale: f64,
) {
    use windows::Win32::Foundation::{COLORREF, POINT};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{CLSID_DragDropHelper, IDragSourceHelper, SHDRAGIMAGE};

    let Ok(helper): windows::core::Result<IDragSourceHelper> =
        (unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) })
    else {
        return;
    };
    let Some((bitmap, size)) = preview
        .and_then(drag_bitmap)
        .or_else(|| cached_drag_bitmap(item, scale))
    else {
        return;
    };
    let image = SHDRAGIMAGE {
        sizeDragImage: size,
        ptOffset: POINT {
            x: size.cx / 2,
            y: size.cy / 2,
        },
        hbmpDragImage: bitmap.0,
        crColorKey: COLORREF(u32::MAX),
    };
    // The Shell drag-image helper takes ownership of this HBITMAP.
    std::mem::forget(bitmap);
    let _ = unsafe { helper.InitializeFromBitmap(&image, data) };
}

#[cfg(windows)]
fn shell_transfer(
    window: &WebviewWindow,
    file: &Path,
    drag: bool,
    preview: Option<&DragPreview>,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{IBindCtx, IDataObject};
    use windows::Win32::System::Ole::{
        IDropSource, OleFlushClipboard, OleInitialize, OleSetClipboard, DROPEFFECT_COPY,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::Shell::{
        BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    unsafe {
        let primary_is_down = || {
            let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                VK_RBUTTON
            } else {
                VK_LBUTTON
            };
            GetAsyncKeyState(i32::from(button.0)) < 0
        };
        if drag && !primary_is_down() {
            return Ok(());
        }
        OleInitialize(None).map_err(|_| "Windows 暂时无法使用文件拖放或剪贴板。")?;
        let _apartment = OleApartment;
        let name = HSTRING::from(file.as_os_str());
        let item: IShellItem = SHCreateItemFromParsingName(&name, None::<&IBindCtx>)
            .map_err(|_| "文件副本暂不可用。")?;
        let data: IDataObject = item
            .BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
            .map_err(|_| "无法准备 Windows 文件传输。")?;
        if drag {
            let hwnd = window.hwnd().map_err(|_| "无法取得见藏窗口。")?;
            attach_drag_preview(&item, &data, preview, window.scale_factor().unwrap_or(1.0));
            if !primary_is_down() {
                return Ok(());
            }
            SHDoDragDrop(Some(hwnd), &data, None::<&IDropSource>, DROPEFFECT_COPY)
                .map_err(|_| "Windows 无法开始拖出。")?;
        } else {
            OleSetClipboard(&data)
                .and_then(|()| OleFlushClipboard())
                .map_err(|_| "剪贴板正忙，请重试复制。")?;
        }
    }
    Ok(())
}

pub async fn transfer_file(
    window: WebviewWindow,
    file: PathBuf,
    drag: bool,
    preview: Option<DragPreview>,
) -> Result<Value, String> {
    if !file.is_absolute() {
        return Err("文件副本位置无效。".into());
    }
    #[cfg(windows)]
    {
        let (complete, result) = std::sync::mpsc::sync_channel(1);
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                let result = if drag {
                    let state = owner.state::<FileDrop>();
                    state.begin_outgoing(file.clone()).and_then(|()| {
                        let result = shell_transfer(&owner, &file, true, preview.as_ref());
                        state.end_outgoing();
                        result
                    })
                } else {
                    shell_transfer(&owner, &file, false, None)
                };
                let _ = complete.send(result);
            })
            .map_err(|_| "无法访问见藏窗口。")?;
        let shell_result = tauri::async_runtime::spawn_blocking(move || result.recv())
            .await
            .map_err(|_| "文件传输已结束。")?
            .map_err(|_| "文件传输已结束。")?;
        shell_result?;
        return Ok(if drag {
            json!({"ok": true})
        } else {
            json!({"ok": true, "message": "文件已复制，可在资源管理器或支持文件粘贴的应用中粘贴。"})
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (window, drag, preview);
        Err("此操作需要 Windows。".into())
    }
}
pub fn open(target: &std::ffi::OsStr) -> Result<Value, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::null;
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let file: Vec<u16> = target.encode_wide().chain([0]).collect();
        if file[..file.len() - 1].contains(&0) {
            return Err("打开的位置无效。".into());
        }
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                null(),
                file.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("系统无法打开该项目，请检查默认应用。".into());
        }
    }
    #[cfg(not(windows))]
    std::process::Command::new("/usr/bin/open")
        .arg(target)
        .spawn()
        .map_err(|_| "系统无法打开该项目。")?;
    Ok(json!({ "ok": true }))
}

pub fn installation(name: &str, args: &[Value]) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(json!({ "ok": true, "supported": false }));
    }
    let program = std::env::current_exe().map_err(|_| "无法读取程序位置。")?;
    let directory = program.parent().ok_or("无法读取程序目录。")?;
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or("无法读取安装目录。")?;
    let production = std::fs::read(directory.join("backend/release-mode.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
        .is_some_and(|mode| mode["production"] == true);
    let install_folder = if production {
        "JianCang-WebView2".to_owned()
    } else {
        format!("JianCang-Tauri-Candidate-{}", env!("CARGO_PKG_VERSION"))
    };
    let destination = local.join("Programs").join(install_folder);
    let uninstaller = destination.join("Uninstall.exe");
    let expected = destination.join("jiancang-tauri.exe");
    let installed = expected
        .canonicalize()
        .is_ok_and(|exe| program.canonicalize().is_ok_and(|current| exe == current));
    let can_uninstall = installed
        && uninstaller
            .symlink_metadata()
            .is_ok_and(|info| info.is_file() && !info.is_symlink())
        && destination
            .symlink_metadata()
            .is_ok_and(|info| info.is_dir() && !info.is_symlink());
    match name {
        "windows-installation:status" => Ok(
            json!({ "ok": true, "supported": true, "directory": directory,
            "destination": destination, "installed": installed, "canManage": can_uninstall, "canRepair": false }),
        ),
        "windows-installation:open-location" => open(directory.as_os_str()),
        "windows-installation:manage"
            if can_uninstall && args.first().and_then(Value::as_str) == Some("uninstall") =>
        {
            open(Path::new(&uninstaller).as_os_str())
        }
        _ => Err("请使用这个版本的安装程序管理安装。".into()),
    }
}
