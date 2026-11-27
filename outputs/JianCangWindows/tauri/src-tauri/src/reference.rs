use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
pub struct ReferenceWindows {
    sequence: AtomicU64,
    closing: AtomicBool,
    entries: Mutex<HashMap<String, Arc<ReferenceWindow>>>,
}

struct ReferenceWindow {
    original: String,
    thumbnail: String,
    fragment: String,
    shown: AtomicBool,
    menu_open: AtomicBool,
    viewport: Mutex<Viewport>,
}

#[derive(Default)]
struct Viewport {
    image: Option<PhysicalSize<u32>>,
    zoom: Option<Zoom>,
    drag: Option<Drag>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Bounds {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

struct Zoom {
    current: Bounds,
    target: Bounds,
    scale: f64,
}

struct Drag {
    gesture: u32,
    position: PhysicalPosition<i32>,
    cursor: Option<PhysicalPosition<f64>>,
    dpi: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResizeMode {
    Fit,
    Actual,
    Step,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ReferenceAction {
    Ready,
    ImageSize {
        width: u32,
        height: u32,
    },
    Resize {
        mode: ResizeMode,
        multiplier: f64,
        anchor_x: f64,
        anchor_y: f64,
        animate: bool,
    },
    AdvanceZoom,
    BeginMove {
        gesture: u32,
        x: f64,
        y: f64,
    },
    Move {
        gesture: u32,
        dx: i32,
        dy: i32,
    },
    EndMove {
        gesture: u32,
    },
    Menu {
        image_visible: bool,
        can_retry: bool,
        opacity: Option<u8>,
    },
    Pin {
        pinned: bool,
    },
    Close,
}

fn reference_document(url: &Url, fragment: &str) -> bool {
    crate::trusted_origin(url)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/reference.html"
        && url.query().is_none()
        && url.fragment() == Some(fragment)
}

fn reference_path(registration: &str, asset: &str) -> Result<String, String> {
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    if registration.is_empty()
        || registration.len() > 64
        || !registration.bytes().all(|byte| hex(byte) || byte == b'-')
        || asset.len() != 64
        || !asset.bytes().all(hex)
    {
        return Err("参考图标识无效。".into());
    }
    Ok(format!("/{registration}/{asset}"))
}

impl ReferenceWindows {
    fn entry(&self, label: &str) -> Option<Arc<ReferenceWindow>> {
        self.entries.lock().ok()?.get(label).cloned()
    }

    fn remove(&self, label: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(label);
        }
    }
}

pub fn allows_media(app: &AppHandle, label: &str, path: &str) -> bool {
    app.try_state::<ReferenceWindows>()
        .and_then(|windows| windows.entry(label))
        .is_some_and(|entry| entry.original == path || entry.thumbnail == path)
}

pub fn close_all(app: &AppHandle) {
    let Some(windows) = app.try_state::<ReferenceWindows>() else {
        return;
    };
    windows.closing.store(true, Ordering::Release);
    let labels: Vec<String> = windows
        .entries
        .lock()
        .map(|entries| entries.keys().cloned().collect())
        .unwrap_or_default();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

pub fn open(
    app: &AppHandle,
    registration: &str,
    asset: &str,
    name: &str,
    original_available: bool,
) -> Result<(), String> {
    let path = reference_path(registration, asset)?;
    let original = format!("/original{path}");
    let windows = app.state::<ReferenceWindows>();
    let mut entries = windows.entries.lock().map_err(|_| "参考窗状态不可用。")?;
    if windows.closing.load(Ordering::Acquire) {
        return Err("见藏正在关闭。".into());
    }
    if let Some((label, state)) = entries.iter().find(|(_, state)| state.original == original) {
        let label = label.clone();
        let shown = state.shown.load(Ordering::Acquire);
        drop(entries);
        if shown {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        return Ok(());
    }

    let role = if original_available {
        "original"
    } else {
        "thumbnail"
    };
    let fragment = format!("{role}{path}");
    let label = format!(
        "reference-{}",
        windows.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let entry = Arc::new(ReferenceWindow {
        original,
        thumbnail: format!("/thumbnail{path}"),
        fragment: fragment.clone(),
        shown: AtomicBool::new(false),
        menu_open: AtomicBool::new(false),
        viewport: Mutex::new(Viewport::default()),
    });
    entries.insert(label.clone(), entry.clone());
    drop(entries);

    let title: String = name
        .chars()
        .filter(|ch| !ch.is_control())
        .take(200)
        .collect();
    let url = WebviewUrl::App(format!("reference.html#{fragment}").into());
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title(if title.is_empty() {
            "见藏参考窗"
        } else {
            &title
        })
        .inner_size(360.0, 300.0)
        .center()
        .visible(false)
        .focused(false)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true);
    // Use Tao's transparent DWM host and Wry's zero-alpha WebView2 background.
    // A native background color here would paint the host with an opaque brush.
    #[cfg(windows)]
    let builder = builder.transparent(true);
    #[cfg(not(windows))]
    let builder = builder.background_color(tauri::window::Color(19, 20, 20, 255));
    let result = builder
        .use_https_scheme(true)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(false)
        .on_navigation(move |url| reference_document(url, &fragment))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    let window = result.map_err(|_| {
        windows.remove(&label);
        "无法打开参考窗。"
    })?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            handle.state::<ReferenceWindows>().remove(&label);
        }
    });
    if windows.closing.load(Ordering::Acquire) {
        let _ = window.destroy();
        return Err("见藏正在关闭。".into());
    }
    // Hidden WebView2 surfaces may throttle RAF while the first image is loading.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        let _ = show(&window, &entry);
    });
    Ok(())
}

fn show(window: &WebviewWindow, entry: &ReferenceWindow) -> Result<(), String> {
    if !entry.shown.swap(true, Ordering::AcqRel) && window.show().is_err() {
        entry.shown.store(false, Ordering::Release);
        return Err("参考窗无法显示。".into());
    }
    Ok(())
}

fn bounds(window: &WebviewWindow) -> Result<Bounds, String> {
    let position = window
        .outer_position()
        .map_err(|_| "无法读取参考窗位置。")?;
    let size = window.inner_size().map_err(|_| "无法读取参考窗大小。")?;
    Ok(Bounds { position, size })
}

fn apply_bounds(window: &WebviewWindow, rect: Bounds) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|_| "无法访问参考窗。")?;
        let outer = window.outer_size().map_err(|_| "无法读取参考窗大小。")?;
        let inner = window.inner_size().map_err(|_| "无法读取参考窗大小。")?;
        let width = rect.size.width + outer.width.saturating_sub(inner.width);
        let height = rect.size.height + outer.height.saturating_sub(inner.height);
        // Submit a single move and resize so WebView2 never paints intermediate bounds.
        let result = unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                rect.position.x,
                rect.position.y,
                width as i32,
                height as i32,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        };
        if result == 0 {
            return Err("无法调整参考窗大小。".into());
        }
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(rect.size)
            .map_err(|_| "无法调整参考窗大小。")?;
        window
            .set_position(rect.position)
            .map_err(|_| "无法移动参考窗。")?;
    }
    Ok(())
}

fn fit_axis(position: i32, origin: i32, free_space: i32) -> i32 {
    position.clamp(origin + free_space.min(0), origin + free_space.max(0))
}

fn resize(
    window: &WebviewWindow,
    entry: &ReferenceWindow,
    view: &mut Viewport,
    mode: ResizeMode,
    multiplier: f64,
    anchor: (f64, f64),
    animate: bool,
) -> Result<Value, String> {
    let Some(image) = view.image else {
        return Err("图片尺寸不可用。".into());
    };
    if view.drag.is_some() {
        return Err("请松开鼠标后再缩放参考窗。".into());
    }
    if !(0.0625..=16.0).contains(&multiplier)
        || ![anchor.0, anchor.1]
            .iter()
            .all(|value| (0.0..=1.0).contains(value))
    {
        return Err("无效的参考窗尺寸。".into());
    }
    let dpi = window
        .scale_factor()
        .map_err(|_| "无法读取显示缩放比例。")?;
    let current = bounds(window)?;
    let screen = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let usable = screen.as_ref().map(|monitor| monitor.work_area());
    let natural_width = f64::from(image.width);
    let natural_height = f64::from(image.height);
    let longest = natural_width.max(natural_height);
    let max = (8192.0 / longest)
        .min((48.0 * 1024.0 * 1024.0 / (natural_width * natural_height)).sqrt())
        / dpi;
    let min = max.min(56.0 / longest);
    let target_scale = match mode {
        ResizeMode::Actual => 1.0,
        ResizeMode::Fit => {
            let width = usable.map_or(740.0, |rect| (f64::from(rect.size.width) / dpi).min(740.0));
            let height =
                usable.map_or(620.0, |rect| (f64::from(rect.size.height) / dpi).min(620.0));
            (width / natural_width).min(height / natural_height)
        }
        ResizeMode::Step => {
            let previous = view.zoom.as_ref().map_or_else(
                || f64::from(current.size.width.max(current.size.height)) / (longest * dpi),
                |zoom| zoom.scale,
            );
            previous * multiplier
        }
    };
    let scale = target_scale.clamp(min, max);
    let size = PhysicalSize::new(
        (natural_width * scale * dpi).round().max(1.0) as u32,
        (natural_height * scale * dpi).round().max(1.0) as u32,
    );
    let mut position = PhysicalPosition::new(
        current.position.x
            + ((f64::from(current.size.width) - f64::from(size.width)) * anchor.0).round() as i32,
        current.position.y
            + ((f64::from(current.size.height) - f64::from(size.height)) * anchor.1).round() as i32,
    );
    if let Some(usable) = usable.filter(|_| !matches!(mode, ResizeMode::Step)) {
        position.x = fit_axis(
            position.x,
            usable.position.x,
            usable.size.width as i32 - size.width as i32,
        );
        position.y = fit_axis(
            position.y,
            usable.position.y,
            usable.size.height as i32 - size.height as i32,
        );
    }
    let target = Bounds { position, size };
    if view.zoom.as_ref().is_some_and(|zoom| zoom.target == target) {
        return Ok(json!({ "ok": true, "running": true, "scale": scale }));
    }
    view.zoom = None;
    if target != current {
        if animate && entry.shown.load(Ordering::Acquire) {
            view.zoom = Some(Zoom {
                current,
                target,
                scale,
            });
        } else {
            apply_bounds(window, target)?;
        }
    }
    Ok(json!({ "ok": true, "running": view.zoom.is_some(), "scale": scale }))
}

fn advance_zoom(window: &WebviewWindow, view: &mut Viewport) -> Result<Value, String> {
    let Some(mut zoom) = view.zoom.take() else {
        return Ok(json!({ "running": false }));
    };
    let start = zoom.current;
    let target = zoom.target;
    let change = (f64::from(target.size.width) / f64::from(start.size.width) - 1.0)
        .abs()
        .max((f64::from(target.size.height) / f64::from(start.size.height) - 1.0).abs());
    let amount = 0.38_f64.min(0.14 / change);
    let blend = |from: f64, to: f64| (from + (to - from) * amount).round();
    let next = Bounds {
        position: PhysicalPosition::new(
            blend(f64::from(start.position.x), f64::from(target.position.x)) as i32,
            blend(f64::from(start.position.y), f64::from(target.position.y)) as i32,
        ),
        size: PhysicalSize::new(
            blend(f64::from(start.size.width), f64::from(target.size.width)) as u32,
            blend(f64::from(start.size.height), f64::from(target.size.height)) as u32,
        ),
    };
    let distance = [
        next.position.x.abs_diff(target.position.x),
        next.position.y.abs_diff(target.position.y),
        next.size.width.abs_diff(target.size.width),
        next.size.height.abs_diff(target.size.height),
    ]
    .into_iter()
    .max()
    .unwrap_or(0);
    let finished = distance <= 3 || next == start;
    let next = if finished { target } else { next };
    apply_bounds(window, next)?;
    if !finished {
        zoom.current = next;
        view.zoom = Some(zoom);
    }
    let dpi = window
        .scale_factor()
        .map_err(|_| "无法读取显示缩放比例。")?;
    let logical = next.size.to_logical::<u32>(dpi);
    Ok(json!({ "running": !finished, "width": logical.width, "height": logical.height }))
}

fn begin_move(
    window: &WebviewWindow,
    view: &mut Viewport,
    gesture: u32,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let dpi = window
        .scale_factor()
        .map_err(|_| "无法读取显示缩放比例。")?;
    let rect = bounds(window)?;
    if !view.image.is_some()
        || view.drag.is_some()
        || !(0.0..=f64::from(rect.size.width) / dpi).contains(&x)
        || !(0.0..=f64::from(rect.size.height) / dpi).contains(&y)
    {
        return Err("无法开始拖动参考窗。".into());
    }
    let cursor = window.inner_position().ok().map(|inner| {
        PhysicalPosition::new(f64::from(inner.x) + x * dpi, f64::from(inner.y) + y * dpi)
    });
    view.zoom = None;
    view.drag = Some(Drag {
        gesture,
        position: rect.position,
        cursor,
        dpi,
    });
    Ok(())
}

fn drag(
    window: &WebviewWindow,
    view: &Viewport,
    gesture: u32,
    dx: i32,
    dy: i32,
) -> Result<(), String> {
    let Some(drag) = view.drag.as_ref().filter(|drag| drag.gesture == gesture) else {
        return Ok(());
    };
    if dx.unsigned_abs() >= 65_536 || dy.unsigned_abs() >= 65_536 {
        return Err("参考窗位置无效。".into());
    }
    let (dx, dy) = match (drag.cursor, window.cursor_position()) {
        (Some(start), Ok(current)) => (current.x - start.x, current.y - start.y),
        _ => (f64::from(dx) * drag.dpi, f64::from(dy) * drag.dpi),
    };
    let next = PhysicalPosition::new(
        drag.position.x + dx.round() as i32,
        drag.position.y + dy.round() as i32,
    );
    window
        .set_position(next)
        .map_err(|_| "无法移动参考窗。".into())
}

#[cfg(windows)]
fn popup(
    window: &WebviewWindow,
    has_image: bool,
    can_retry: bool,
    opacity: u8,
) -> Result<Option<&'static str>, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, TrackPopupMenu, HMENU, MF_CHECKED,
        MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON,
    };

    struct Popup(HMENU);
    impl Drop for Popup {
        fn drop(&mut self) {
            unsafe { DestroyMenu(self.0) };
        }
    }
    let hwnd = window.hwnd().map_err(|_| "无法访问参考窗。")?;
    let pinned = window
        .is_always_on_top()
        .map_err(|_| "无法读取参考窗置顶状态。")?;
    let menu = Popup(unsafe { CreatePopupMenu() });
    let levels = Popup(unsafe { CreatePopupMenu() });
    if menu.0.is_null() || levels.0.is_null() {
        return Err("无法打开参考窗菜单。".into());
    }
    let append = |target: &Popup, flags, id, label: &str| {
        let label: Vec<u16> = label.encode_utf16().chain([0]).collect();
        let result = unsafe { AppendMenuW(target.0, flags, id, label.as_ptr()) };
        if result == 0 {
            Err("无法创建参考窗菜单。".to_owned())
        } else {
            Ok(())
        }
    };
    let available = if has_image { MF_STRING } else { MF_GRAYED };
    let pin_flag = if pinned { MF_CHECKED } else { MF_STRING };
    for (id, label, flags) in [
        (1, "复制图片\tCtrl+C", available),
        (2, "重新读取原件", MF_STRING),
        (0, "", MF_SEPARATOR),
        (3, "原始大小（100%）", available),
        (4, "适应窗口", available),
    ] {
        if id == 2 && !can_retry {
            continue;
        }
        append(&menu, flags, id, label)?;
    }
    for (id, percent, label) in [
        (7, 100, "100%"),
        (8, 80, "80%"),
        (9, 60, "60%"),
        (10, 40, "40%"),
    ] {
        append(
            &levels,
            if opacity == percent {
                MF_CHECKED
            } else {
                MF_STRING
            },
            id,
            label,
        )?;
    }
    append(&menu, MF_POPUP, levels.0 as usize, "不透明度")?;
    // DestroyMenu on the parent owns the attached submenu from this point.
    std::mem::forget(levels);
    append(&menu, MF_SEPARATOR, 0, "")?;
    append(&menu, pin_flag, 5, "保持置顶")?;
    append(&menu, MF_STRING, 6, "关闭参考窗")?;
    let mut pointer = POINT::default();
    if unsafe { GetCursorPos(&mut pointer) } == 0 {
        return Err("无法定位参考窗菜单。".into());
    }
    let chosen = unsafe {
        TrackPopupMenu(
            menu.0,
            TPM_NONOTIFY | TPM_RETURNCMD | TPM_RIGHTBUTTON,
            pointer.x,
            pointer.y,
            0,
            hwnd.0,
            null(),
        )
    };
    Ok(match chosen {
        1 => Some("copy"),
        2 => Some("retry"),
        3 => Some("actual"),
        4 => Some("fit"),
        5 => Some("pin"),
        6 => Some("close"),
        7 => Some("opacity-100"),
        8 => Some("opacity-80"),
        9 => Some("opacity-60"),
        10 => Some("opacity-40"),
        _ => None,
    })
}

async fn open_menu(
    window: &WebviewWindow,
    entry: Arc<ReferenceWindow>,
    image_visible: bool,
    can_retry: bool,
    opacity: u8,
) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let has_image =
            image_visible && entry.viewport.lock().is_ok_and(|view| view.image.is_some());
        if entry.menu_open.swap(true, Ordering::AcqRel) {
            return Ok(json!({ "ok": true, "action": null }));
        }
        let owner = window.clone();
        let (complete, result) = std::sync::mpsc::sync_channel(1);
        let state = entry.clone();
        if window
            .run_on_main_thread(move || {
                let action = popup(&owner, has_image, can_retry, opacity);
                state.menu_open.store(false, Ordering::Release);
                let _ = complete.send(action);
            })
            .is_err()
        {
            entry.menu_open.store(false, Ordering::Release);
            return Err("无法打开参考窗菜单。".into());
        }
        let action = tauri::async_runtime::spawn_blocking(move || result.recv())
            .await
            .map_err(|_| "参考窗菜单已关闭。")?
            .map_err(|_| "参考窗菜单已关闭。")??;
        Ok(json!({ "ok": true, "action": action }))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, entry, image_visible, can_retry, opacity);
        Err("参考窗菜单需要 Windows。".into())
    }
}

#[tauri::command]
pub async fn reference_command(
    window: WebviewWindow,
    request: ReferenceAction,
) -> Result<Value, String> {
    let entry = window
        .state::<ReferenceWindows>()
        .entry(window.label())
        .filter(|entry| {
            window
                .url()
                .is_ok_and(|url| reference_document(&url, &entry.fragment))
        })
        .ok_or("仅可从已打开的参考窗使用此操作。")?;
    if let ReferenceAction::Menu {
        image_visible,
        can_retry,
        opacity,
    } = request
    {
        return open_menu(
            &window,
            entry,
            image_visible,
            can_retry,
            opacity.unwrap_or(100).clamp(40, 100),
        )
        .await;
    }
    let mut view = entry.viewport.lock().map_err(|_| "参考窗状态不可用。")?;
    match request {
        ReferenceAction::Ready => show(&window, &entry)?,
        ReferenceAction::ImageSize { width, height } => {
            if !(1..=1_000_000).contains(&width) || !(1..=1_000_000).contains(&height) {
                return Err("图片尺寸不可用。".into());
            }
            view.image = Some(PhysicalSize::new(width, height));
            return resize(
                &window,
                &entry,
                &mut view,
                ResizeMode::Fit,
                1.0,
                (0.5, 0.5),
                false,
            );
        }
        ReferenceAction::Resize {
            mode,
            multiplier,
            anchor_x,
            anchor_y,
            animate,
        } => {
            return resize(
                &window,
                &entry,
                &mut view,
                mode,
                multiplier,
                (anchor_x, anchor_y),
                animate,
            );
        }
        ReferenceAction::AdvanceZoom => return advance_zoom(&window, &mut view),
        ReferenceAction::BeginMove { gesture, x, y } => {
            begin_move(&window, &mut view, gesture, x, y)?
        }
        ReferenceAction::Move { gesture, dx, dy } => drag(&window, &view, gesture, dx, dy)?,
        ReferenceAction::EndMove { gesture } => {
            if view
                .drag
                .as_ref()
                .is_some_and(|drag| drag.gesture == gesture)
            {
                view.drag = None;
            }
        }
        ReferenceAction::Pin { pinned } => {
            window
                .set_always_on_top(pinned)
                .map_err(|_| "参考窗置顶设置未完成。")?;
            return Ok(json!({ "ok": true, "pinned": pinned }));
        }
        ReferenceAction::Close => window.close().map_err(|_| "无法关闭参考窗。")?,
        ReferenceAction::Menu { .. } => unreachable!(),
    }
    Ok(json!({ "ok": true }))
}
