#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod reference;
#[cfg(windows)]
mod window_shell;

use backend::Backend;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::http::{header, Method, Response, StatusCode};
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogResult};

struct LibraryService(Result<Backend, String>);

fn trusted_origin(url: &tauri::Url) -> bool {
    url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
        )
}

fn argument(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}

#[cfg(windows)]
fn lock_legacy_presets() -> Result<Option<std::fs::File>, String> {
    use std::{fs, io::ErrorKind};

    let Some(roaming) = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    else {
        return Ok(None);
    };
    let unavailable = || "无法读取见藏旧版设置，请退出旧版后再试。".to_string();
    let roaming = match roaming.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    let lock = roaming
        .join("见藏")
        .join("Local Storage")
        .join("leveldb")
        .join("LOCK");
    let canonical = match lock.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    if !canonical
        .to_string_lossy()
        .eq_ignore_ascii_case(&lock.to_string_lossy())
        || !fs::symlink_metadata(&lock)
            .map_err(|_| unavailable())?
            .is_file()
    {
        return Err(unavailable());
    }
    // Chromium holds an exclusive lock while the Electron database is open.
    let file = fs::File::open(&lock).map_err(|_| unavailable())?;
    file.try_lock_shared()
        .map_err(|_| "旧版设置仍在使用。请退出见藏旧版后再试。".to_string())?;
    Ok(Some(file))
}

async fn choose_folder(
    window: &WebviewWindow,
    title: &'static str,
) -> Result<Option<PathBuf>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_title(title)
            .set_parent(&window)
            .blocking_pick_folder()
            .and_then(local_path)
    })
    .await
    .map_err(|_| "无法打开文件夹选择窗口。".into())
}

fn local_path(path: FilePath) -> Option<PathBuf> {
    path.into_path().ok()
}

async fn choose_import(
    window: &WebviewWindow,
    folders: bool,
) -> Result<Option<Vec<PathBuf>>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let title = if folders {
            "选择要导入的文件夹"
        } else {
            "选择要导入的文件"
        };
        let picker = window.dialog().file().set_title(title).set_parent(&window);
        let paths = if folders {
            picker.blocking_pick_folders()
        } else {
            picker.blocking_pick_files()
        };
        paths.map(|paths| paths.into_iter().filter_map(local_path).collect())
    })
    .await
    .map_err(|_| "无法打开导入窗口。".into())
}

async fn choose_export(
    window: &WebviewWindow,
    title: &'static str,
    file_name: String,
) -> Result<Option<PathBuf>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_title(title)
            .set_parent(&window)
            .set_file_name(file_name)
            .blocking_save_file()
            .and_then(local_path)
    })
    .await
    .map_err(|_| "无法打开保存窗口。".into())
}

async fn choose_board_project(window: &WebviewWindow) -> Result<Option<PathBuf>, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_title("打开灵感板工程")
            .set_parent(&window)
            .add_filter("见藏灵感板", &["jiancangboard"])
            .blocking_pick_file()
            .and_then(local_path)
    })
    .await
    .map_err(|_| "无法打开灵感板工程选择窗口。".into())
}

fn reveal_path(path: &Path, is_file: bool) -> Result<Value, String> {
    if !path.is_absolute() {
        return Err("文件位置已变化，请刷新素材库。".into());
    }
    #[cfg(windows)]
    let mut shell = Command::new(
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("找不到 Windows 资源管理器。")?)
            .join("explorer.exe"),
    );
    #[cfg(not(windows))]
    let mut shell = Command::new("/usr/bin/open");
    if is_file {
        #[cfg(windows)]
        shell.arg("/select,");
        #[cfg(not(windows))]
        shell.arg("-R");
    }
    shell
        .arg(path)
        .spawn()
        .map_err(|_| "无法在文件管理器中显示此项目。")?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn library_command(
    window: WebviewWindow,
    service: State<'_, LibraryService>,
    name: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !window.url().ok().is_some_and(|url| trusted_origin(&url)) {
        return Err("请从见藏窗口内操作。".into());
    }
    if matches!(
        name.as_str(),
        "windows-installation:status"
            | "windows-installation:open-location"
            | "windows-installation:manage"
    ) {
        return desktop::installation(&name, &args);
    }
    if name == "window:appearance" {
        let dark = args
            .first()
            .and_then(Value::as_bool)
            .ok_or("外观设置无效。")?;
        let theme = if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        };
        window
            .set_theme(Some(theme))
            .map_err(|_| "无法切换窗口外观。")?;
        return Ok(json!({ "ok": true }));
    }
    match name.as_str() {
        "window:state" => {
            let maximized = window.is_maximized().map_err(|_| "无法读取窗口状态。")?;
            #[cfg(windows)]
            let tray_available = window_shell::tray_available(window.app_handle());
            #[cfg(not(windows))]
            let tray_available = false;
            return Ok(json!({ "maximized": maximized, "trayAvailable": tray_available }));
        }
        "window:toggle-maximize" => {
            let maximized = !window.is_maximized().map_err(|_| "无法读取窗口状态。")?;
            if maximized {
                window.maximize()
            } else {
                window.unmaximize()
            }
            .map_err(|_| "无法调整窗口大小。")?;
            return Ok(json!({ "maximized": maximized }));
        }
        "window:minimize" => {
            window.minimize().map_err(|_| "无法最小化窗口。")?;
            return Ok(json!({ "ok": true }));
        }
        "window:close" => {
            #[cfg(windows)]
            window_shell::quit(window.app_handle());
            #[cfg(not(windows))]
            window.close().map_err(|_| "无法关闭窗口。")?;
            return Ok(json!({ "ok": true }));
        }
        #[cfg(windows)]
        "window:hide-to-tray" => {
            window_shell::hide(&window)?;
            return Ok(json!({ "ok": true }));
        }
        #[cfg(windows)]
        "window:startup-status" => return window_shell::startup(None),
        #[cfg(windows)]
        "window:set-startup" => {
            let enabled = args.first().and_then(Value::as_bool).ok_or("启动设置无效。")?;
            return window_shell::startup(Some(enabled));
        }
        "window:drag" => {
            window.start_dragging().map_err(|_| "无法移动窗口。")?;
            return Ok(json!({ "ok": true }));
        }
        _ => {}
    }
    let backend = service.0.as_ref().map_err(Clone::clone)?;
    match name.as_str() {
        "asset:reference" => {
            let info = backend.call("asset:reference-info", args).await?;
            reference::open(
                window.app_handle(),
                info["registrationId"].as_str().ok_or("素材库暂不可用。")?,
                info["assetId"].as_str().ok_or("参考图暂不可用。")?,
                info["name"].as_str().unwrap_or("见藏参考窗"),
                info["originalAvailable"] == true,
            )?;
            Ok(json!({ "ok": true }))
        }
        "offline-web:open" => {
            let target = backend.call(&name, args).await?;
            let url = target["url"].as_str().ok_or("网页地址暂不可用。")?;
            let parsed = tauri::Url::parse(url).map_err(|_| "网页地址无效。")?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("网页地址无效。".into());
            }
            desktop::open(std::ffi::OsStr::new(parsed.as_str()))
        }
        "windows-update:choose-folder" => {
            match choose_folder(&window, "选择见藏签名更新文件夹").await? {
                Some(folder) => {
                    backend
                        .call(&name, vec![json!(folder), argument(&args, 0)])
                        .await
                }
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "windows-update:open-release" => {
            let status = backend.call(&name, vec![]).await?;
            match status["releasePage"].as_str() {
                Some(page @ (
                    "https://github.com/ytlds-64/jiancang-windows-releases/releases/tag/tauri-windows-x64"
                    | "https://github.com/ytlds-64/jiancang-windows-releases/releases/tag/tauri-windows-x64-preview"
                )) => {
                    desktop::open(std::ffi::OsStr::new(page))?;
                    Ok(status)
                }
                _ if status["ok"] == false => Ok(status),
                _ => Err("当前更新通道没有可打开的发布页。".into()),
            }
        }
        "asset:start-drag" | "asset:copy-file" => {
            let drag = name == "asset:start-drag";
            let (command, references) = if drag {
                ("file-transfer:drag-path", vec![argument(&args, 0)])
            } else {
                (
                    "file-transfer:clipboard-path",
                    vec![argument(&args, 0), argument(&args, 1)],
                )
            };
            let path = backend.call(command, references).await?;
            let selected = path.as_str().ok_or("文件副本暂不可用。")?;
            let preview = drag
                .then(|| desktop::DragPreview::from_value(&argument(&args, 1)))
                .flatten();
            let transferred =
                desktop::transfer_file(window, PathBuf::from(selected), drag, preview).await;
            if drag {
                let _ = backend
                    .call("file-transfer:drag-finished", vec![argument(&args, 0)])
                    .await;
            }
            transferred
        }
        "edit:save" => {
            let token = argument(&args, 0);
            let destination = backend
                .call("edit:destination", vec![token.clone()])
                .await?;
            if destination.is_null() {
                return backend.call(&name, vec![token]).await;
            }
            let filename = destination["defaultName"]
                .as_str()
                .ok_or("无法确定导出名称。")?;
            match choose_export(&window, "保存素材", filename.to_owned()).await? {
                Some(file) => backend.call(&name, vec![token, json!(file)]).await,
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "library:choose" | "library:relocate" | "local:create" => {
            let title = match name.as_str() {
                "library:relocate" => "重新定位素材库",
                "local:create" => "选择新建素材库的位置",
                _ => match args.first().and_then(Value::as_str) {
                    Some("eagle") => "选择 Eagle 的 .library 文件夹",
                    Some("jiancang") => "选择见藏同步文件夹",
                    Some("local") => "打开见藏本地库",
                    _ => "添加素材库",
                },
            };
            match choose_folder(&window, title).await? {
                Some(folder) => {
                    backend
                        .call(&name, vec![argument(&args, 0), json!(folder)])
                        .await
                }
                None => backend.call("library:state", vec![]).await,
            }
        }
        "local-import:choose" => {
            let folders = match args.get(2).and_then(Value::as_str) {
                Some("file") => false,
                Some("folder") => true,
                _ => return Err("请选择文件或文件夹。".into()),
            };
            match choose_import(&window, folders).await? {
                Some(paths) if !paths.is_empty() => {
                    backend
                        .call(
                            &name,
                            vec![argument(&args, 0), argument(&args, 1), json!(paths)],
                        )
                        .await
                }
                _ => Ok(json!({ "cancelled": true })),
            }
        }
        "local-import:native-drop" => {
            let token = args
                .get(2)
                .and_then(Value::as_u64)
                .ok_or("没有可导入的拖放文件。")?;
            let paths = window
                .state::<desktop::FileDrop>()
                .take(token)
                .ok_or("拖入的文件已失效，请再拖一次。")?;
            backend
                .call(
                    "local-import:choose",
                    vec![argument(&args, 0), argument(&args, 1), json!(paths)],
                )
                .await
        }
        "local-import:drop-begin" => {
            let mut metadata = argument(&args, 2);
            let metadata = metadata.as_object_mut().ok_or("无法读取拖入的文件数据。")?;
            metadata.remove("paths");
            if let Some(token) = metadata.remove("nativeToken").filter(|value| !value.is_null()) {
                let paths = token.as_u64()
                    .and_then(|token| window.state::<desktop::FileDrop>().take(token))
                    .ok_or("拖入的文件已失效，请再拖一次。")?;
                metadata.insert("paths".into(), json!(paths));
            }
            backend.call(&name, vec![argument(&args, 0), argument(&args, 1), json!(metadata)]).await
        }
        "assets:export-batch" | "structured-export:choose" | "inbox:add" => {
            let title = if name == "inbox:add" {
                "选择要监视的文件夹"
            } else {
                "选择导出位置"
            };
            let Some(folder) = choose_folder(&window, title).await? else {
                return Ok(json!({ "cancelled": true }));
            };
            let selected = if name == "structured-export:choose" {
                vec![json!(folder)]
            } else {
                vec![argument(&args, 0), json!(folder)]
            };
            backend.call(&name, selected).await
        }
        "board:import-project" => match choose_board_project(&window).await? {
            Some(file) => backend.call(&name, vec![json!(file)]).await,
            None => Ok(json!({ "cancelled": true })),
        },
        "local-backup:create" | "local-backup:restore" => {
            let mut selection = vec![argument(&args, 0)];
            let restore = name == "local-backup:restore";
            let source = if restore {
                let Some(path) = choose_folder(&window, "选择见藏备份文件夹").await?
                else {
                    return Ok(json!({ "cancelled": true }));
                };
                Some(path)
            } else {
                None
            };
            let title = if restore {
                "选择恢复后素材库的存放位置"
            } else {
                "选择备份存放位置"
            };
            let Some(destination) = choose_folder(&window, title).await? else {
                return Ok(json!({ "cancelled": true }));
            };
            selection.push(json!(destination));
            if let Some(source) = source {
                selection.push(json!(source));
            }
            backend.call(&name, selection).await
        }
        "local-backup:configure" => {
            let mut selection = vec![argument(&args, 0), argument(&args, 1)];
            if argument(&args, 2).as_bool() == Some(true) {
                let Some(folder) = choose_folder(&window, "选择增量备份存放位置").await?
                else {
                    return Ok(json!({ "cancelled": true }));
                };
                selection.push(json!(folder));
            }
            backend.call(&name, selection).await
        }
        "local-backup:snapshots" => match choose_folder(&window, "选择见藏增量备份文件夹").await?
        {
            Some(folder) => backend.call(&name, vec![json!(folder)]).await,
            None => Ok(json!({ "cancelled": true })),
        },
        "local-backup:restore-snapshot" => {
            let Some(folder) = choose_folder(&window, "选择恢复后素材库的存放位置").await?
            else {
                return Ok(json!({ "cancelled": true }));
            };
            backend
                .call(
                    &name,
                    vec![
                        argument(&args, 0),
                        argument(&args, 1),
                        argument(&args, 2),
                        json!(folder),
                    ],
                )
                .await
        }
        "board:export" | "asset:save-markers" => {
            let (validation, title) = if name == "board:export" {
                ("board:export-name", "导出灵感板")
            } else {
                ("asset:save-markers-name", "导出视频备注")
            };
            let payload = argument(&args, 0);
            let destination = backend.call(validation, vec![payload.clone()]).await?;
            let filename = destination["defaultName"]
                .as_str()
                .ok_or("无法确定文件名。")?;
            match choose_export(&window, title, filename.to_owned()).await? {
                Some(file) => backend.call(&name, vec![payload, json!(file)]).await,
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "asset:export" => {
            let mut references = vec![argument(&args, 0), argument(&args, 1)];
            let filename = backend
                .call("asset:export-name", references.clone())
                .await?;
            let filename = filename.as_str().ok_or("无法确定素材的文件名。")?;
            match choose_export(&window, "导出原件", filename.to_owned()).await? {
                Some(file) => {
                    references.push(json!(file));
                    backend.call(&name, references).await
                }
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "video-trim:export" => {
            let options = argument(&args, 0);
            let destination = backend
                .call("video-trim:destination", vec![options.clone()])
                .await?;
            let filename = destination["defaultName"]
                .as_str()
                .ok_or("无法确定导出文件名。")?;
            match choose_export(&window, "导出视频选段", filename.to_owned()).await? {
                Some(path) => backend.call(&name, vec![options, json!(path)]).await,
                None => Ok(json!({ "cancelled": true })),
            }
        }
        "browser-capture:extension" => {
            let status = backend.call(&name, vec![]).await?;
            let directory = status["directory"]
                .as_str()
                .ok_or("找不到采集扩展文件夹。")?;
            reveal_path(Path::new(directory), false)
        }
        "asset:open-link" | "asset:open-default" => {
            let command = if name == "asset:open-link" {
                "asset:link-url"
            } else {
                "asset:default-path"
            };
            let target = backend.call(command, args).await?;
            let value = target.as_str().ok_or("无法打开素材。")?;
            desktop::open(std::ffi::OsStr::new(value))
        }
        "library:reveal"
        | "library:reveal-open-folder"
        | "library:reveal-reading-item"
        | "asset:reveal"
        | "sync:reveal-latest-record" => {
            let (command, is_file) = match name.as_str() {
                "asset:reveal" => ("asset:reveal-path", true),
                "library:reveal-open-folder" => ("library:reveal-open-path", false),
                "library:reveal-reading-item" => ("library:reveal-reading-path", false),
                "sync:reveal-latest-record" => ("sync:latest-record-path", true),
                _ => ("library:reveal-path", false),
            };
            let path = backend.call(command, args).await?;
            reveal_path(Path::new(path.as_str().ok_or("文件暂不可用。")?), is_file)
        }
        "library:state"
        | "library:switch"
        | "library:remove"
        | "library:refresh"
        | "library:refresh-all"
        | "library:cancel-open"
        | "local:mutate"
        | "local-import:list"
        | "local-import:retry"
        | "local-import:retry-failed"
        | "local-import:cancel"
        | "local-import:cancel-pending"
        | "local-import:set-paused"
        | "local-import:copy-assets"
        | "local-import:copy-eagle"
        | "local-import:drop-items"
        | "local-import:drop-append"
        | "local-import:drop-finish"
        | "local-import:drop-discard"
        | "local-import:capture-paste"
        | "local-import:release-paste"
        | "local-import:paste"
        | "desktop:status"
        | "eagle:configure-write"
        | "eagle:edit"
        | "sync:configure-write"
        | "sync:retry-write"
        | "sync-conflicts:list"
        | "sync-conflicts:resolve"
        | "browser-capture:status"
        | "browser-capture:history"
        | "browser-capture:copy-history-address"
        | "browser-capture:configure"
        | "browser-capture:rule-save"
        | "browser-capture:rule-change"
        | "browser-capture:disconnect"
        | "video-trim:probe"
        | "asset:video-metadata"
        | "studio:list"
        | "studio:write"
        | "video-trim:preview"
        | "video-trim:cancel"
        | "video-trim:release"
        | "video-trim:status"
        | "visual:lookup"
        | "visual:start"
        | "visual:status"
        | "visual:cancel"
        | "visual:similar"
        | "visual:copy-text"
        | "visual:copy-color"
        | "visual:copy-palette"
        | "assets:write-clipboard"
        | "assets:copy-preview-text"
        | "structured-export:plan"
        | "structured-export:start"
        | "structured-export:status"
        | "image-conversion:start"
        | "image-conversion:status"
        | "image-conversion:cancel"
        | "local-backup:status"
        | "local-backup:cancel"
        | "local-backup:plan"
        | "local-backup:run"
        | "board:export-begin"
        | "board:export-append"
        | "board:export-discard"
        | "inbox:list"
        | "inbox:pause"
        | "inbox:remove"
        | "inbox:scan"
        | "duplicates:start"
        | "duplicates:status"
        | "duplicates:cancel"
        | "duplicates:resume"
        | "duplicates:retry"
        | "duplicates:preview-merge"
        | "duplicates:merge"
        | "duplicates:trash"
        | "suggestion:settings"
        | "suggestion:local-models"
        | "suggestion:save-settings"
        | "suggestion:start"
        | "suggestion:batch"
        | "suggestion:retry"
        | "suggestion:retry-failed"
        | "suggestion:pause"
        | "suggestion:resume"
        | "suggestion:cancel"
        | "suggestion:discard"
        | "suggestion:apply"
        | "asset:prepare-drag"
        | "edit:upload-begin"
        | "edit:upload-append"
        | "edit:upload-discard"
        | "storage:status"
        | "storage:clear-thumbnails"
        | "cloud-originals:status"
        | "cloud-originals:start"
        | "cloud-originals:retry"
        | "cloud-originals:pause"
        | "cloud-originals:remove-task"
        | "cloud-originals:history-clear"
        | "cloud-originals:copy-failures"
        | "windows-update:status"
        | "windows-update:check"
        | "windows-update:set-channel"
        | "windows-update:restore-channel"
        | "windows-update:set-automatic"
        | "windows-update:cancel"
        | "windows-update:install"
        | "offline-web:get"
        | "offline-web:remove"
        | "offline-web:capture-start"
        | "offline-web:capture-finish"
        | "offline-web:capture-cancel"
        | "natural-search:start"
        | "natural-search:status"
        | "natural-search:cancel" => backend.call(&name, args).await,
        "presets:import-legacy" => {
            #[cfg(windows)]
            let _lock = lock_legacy_presets()?;
            backend.call(&name, Vec::new()).await
        }
        _ => Err("此功能正在迁移到 Tauri，可在当前正式版中使用。".into()),
    }
}

fn start_capture_approvals(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<LibraryService>();
        let Ok(backend) = &state.0 else {
            return;
        };
        while let Some(window) = app.get_webview_window("main") {
            let status = tauri::async_runtime::block_on(
                backend.call("browser-capture:worker-state", vec![]),
            );
            if let Ok(status) = status {
                if let Some(id) = status["pairing"]["id"].as_str() {
                    let button = "允许连接";
                    let result = window.dialog()
                        .message("浏览器的见藏采集扩展请求连接。允许后，它可以将你选中的网页素材保存到见藏。")
                        .title("浏览器采集连接")
                        .parent(&window)
                        .buttons(MessageDialogButtons::OkCancelCustom(button.into(), "拒绝".into()))
                        .blocking_show_with_result();
                    let approved = result == MessageDialogResult::Custom(button.into())
                        || result == MessageDialogResult::Ok;
                    let _ = tauri::async_runtime::block_on(backend.call(
                        "browser-capture:worker-resolve",
                        vec![json!(id), json!(approved)],
                    ));
                }
            }
            std::thread::sleep(Duration::from_millis(650));
        }
    });
}

fn local_media_origin() -> &'static str {
    if cfg!(windows) {
        "https://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _| {
        window_shell::second_instance(app, args);
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(reference::ReferenceWindows::default())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            #[cfg(windows)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window_shell::ask_close(window) {
                    api.prevent_close();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                reference::close_all(window.app_handle());
            }
        })
        .setup(|app| {
            #[cfg(windows)]
            if window_shell::installer_request() {
                app.handle().exit(0);
                return Ok(());
            }
            let root = app.path().resource_dir()?.join("backend");
            let profile = app.path().app_data_dir()?;
            let installed = desktop::installation("windows-installation:status", &[])
                .ok()
                .is_some_and(|state| state["installed"] == true);
            let downloads = app.path().download_dir().ok();
            app.manage(LibraryService(Backend::launch(
                &root,
                &profile,
                installed,
                downloads.as_deref(),
            )));
            app.manage(desktop::FileDrop::default());
            let config = app
                .config()
                .app
                .windows
                .first()
                .expect("main window config");
            let window = WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(trusted_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            #[cfg(windows)]
            let use_webview_drop = desktop::supports_webview_file_drop();
            #[cfg(not(windows))]
            let use_webview_drop = false;
            let window = if use_webview_drop { window.disable_drag_drop_handler() } else { window };
            let window = window.build()?;
            #[cfg(windows)]
            if use_webview_drop { desktop::connect_webview_drop(&window); }
            if !use_webview_drop { desktop::connect_drop(&window); }
            #[cfg(windows)]
            let _ = window_shell::setup_tray(app);
            start_capture_approvals(app.handle().clone());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(
            "jiancangmedia",
            |context, request, responder| {
                let app = context.app_handle().clone();
                let trusted = context.webview_label() == "main"
                    || reference::allows_media(&app, context.webview_label(), request.uri().path());
                tauri::async_runtime::spawn(async move {
                    let origin = local_media_origin();
                    let result = if !trusted
                        || request
                            .headers()
                            .get(header::ORIGIN)
                            .is_some_and(|value| value.as_bytes() != origin.as_bytes())
                    {
                        Err(StatusCode::FORBIDDEN)
                    } else if request.method() == Method::OPTIONS {
                        Ok(Response::builder()
                            .status(StatusCode::NO_CONTENT)
                            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD")
                            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
                            .body(Vec::new())
                            .expect("fixed response"))
                    } else if request.method() != Method::GET && request.method() != Method::HEAD {
                        Err(StatusCode::METHOD_NOT_ALLOWED)
                    } else if let Ok(backend) = &app.state::<LibraryService>().0 {
                        backend.media(&request).await
                    } else {
                        Err(StatusCode::SERVICE_UNAVAILABLE)
                    };
                    let mut response = result.unwrap_or_else(|status| {
                        Response::builder()
                            .status(status)
                            .body(Vec::new())
                            .expect("empty error response")
                    });
                    let headers = response.headers_mut();
                    headers.insert(
                        header::ACCESS_CONTROL_ALLOW_ORIGIN,
                        origin.parse().expect("valid origin"),
                    );
                    headers.insert(
                        header::ACCESS_CONTROL_EXPOSE_HEADERS,
                        "Accept-Ranges, Content-Length, Content-Range"
                            .parse()
                            .unwrap(),
                    );
                    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
                    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                    responder.respond(response);
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            library_command,
            reference::reference_command
        ])
        .run(tauri::generate_context!())
        .expect("could not start JianCang");
}
