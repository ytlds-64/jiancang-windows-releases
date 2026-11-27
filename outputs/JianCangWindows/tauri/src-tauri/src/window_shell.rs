use crate::{desktop, reference};
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, WebviewWindow, Window};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_BINARY};
use winreg::RegKey;

const TRAY_ID: &str = "jiancang-main";
const INSTALLER_EXIT_ARGUMENT: &str = "--jiancang-installation-exit";
const STARTUP_NAME: &str = "JianCang.WebView2";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVAL_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

pub fn installer_request() -> bool {
    std::env::args_os().nth(1).as_deref() == Some(OsStr::new(INSTALLER_EXIT_ARGUMENT))
}

pub fn second_instance(app: &AppHandle, args: Vec<String>) {
    if args.get(1).map(String::as_str) == Some(INSTALLER_EXIT_ARGUMENT) {
        // The installer starts the matching executable. A different candidate
        // shares the same single-instance ID and must not close this one.
        if let (Some(path), Ok(current)) = (args.first(), std::env::current_exe()) {
            if same_executable(Path::new(path), &current) {
                quit(app);
            }
        }
        return;
    }
    show(app);
}

fn same_executable(path: &Path, current: &Path) -> bool {
    path.canonicalize()
        .ok()
        .is_some_and(|path| current.canonicalize().is_ok_and(|current| current == path))
}

pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "jiancang-show", "显示见藏", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "jiancang-quit", "退出见藏", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("见藏")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "jiancang-show" => show(app),
            "jiancang-quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn quit(app: &AppHandle) {
    reference::close_all(app);
    app.exit(0);
}

pub fn ask_close(window: &Window) -> bool {
    window
        .app_handle()
        .get_webview_window("main")
        .is_some_and(|window| {
            window
                .eval("window.dispatchEvent(new Event('jiancang-window-close-requested'));")
                .is_ok()
        })
}

pub fn tray_available(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

pub fn hide(window: &WebviewWindow) -> Result<(), String> {
    if !tray_available(window.app_handle()) {
        return Err("系统通知区域暂不可用。".into());
    }
    window
        .hide()
        .map_err(|_| "无法将窗口最小化到通知区域。".into())
}

fn installed_command() -> Result<Option<OsString>, String> {
    let install = desktop::installation("windows-installation:status", &[])?;
    let Some(directory) = install["destination"].as_str().map(PathBuf::from) else {
        return Ok(None);
    };
    if install["installed"] != true
        || install["canManage"] != true
        || directory.file_name() != Some(OsStr::new("JianCang-WebView2"))
    {
        return Ok(None);
    }
    let mut command = OsString::from("\"");
    command.push(directory.join("jiancang-tauri.exe"));
    command.push("\"");
    Ok(Some(command))
}

fn optional_key(user: &RegKey, path: &str, access: u32) -> io::Result<Option<RegKey>> {
    optional(user.open_subkey_with_flags(path, access | KEY_WOW64_64KEY))
}

fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_registration(user: &RegKey, expected: &OsStr) -> io::Result<bool> {
    let Some(run) = optional_key(user, RUN_KEY, KEY_READ)? else {
        return Ok(false);
    };
    Ok(
        optional(run.get_value::<OsString, _>(STARTUP_NAME))?.is_some_and(|value| {
            value
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy())
        }),
    )
}

fn disabled_by_windows(user: &RegKey) -> io::Result<bool> {
    let Some(key) = optional_key(user, APPROVAL_KEY, KEY_READ)? else {
        return Ok(false);
    };
    // Explorer stores the approval separately when Windows Settings disables
    // a Run entry. The first byte distinguishes its enabled and disabled states.
    Ok(
        optional(key.get_raw_value(STARTUP_NAME))?.is_some_and(|value| {
            value.vtype == REG_BINARY && value.bytes.first().is_some_and(|flag| flag & 1 != 0)
        }),
    )
}

fn change_startup(user: &RegKey, command: &OsString, enabled: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    if enabled {
        if command.encode_wide().count() > 260 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "startup command too long",
            ));
        }
        let (run, _) = user.create_subkey_with_flags(RUN_KEY, KEY_SET_VALUE | KEY_WOW64_64KEY)?;
        run.set_value(STARTUP_NAME, command)?;
        // An explicit enable in the app clears its own stale disabled decision.
        if disabled_by_windows(user)? {
            if let Some(approval) = optional_key(user, APPROVAL_KEY, KEY_SET_VALUE)? {
                optional(approval.delete_value(STARTUP_NAME))?;
            }
        }
    } else if read_registration(user, command)? {
        if let Some(run) = optional_key(user, RUN_KEY, KEY_SET_VALUE)? {
            optional(run.delete_value(STARTUP_NAME))?;
        }
    }
    Ok(())
}

pub fn startup(enabled: Option<bool>) -> Result<Value, String> {
    let Some(command) = installed_command()? else {
        return Ok(json!({ "supported": false, "enabled": false }));
    };
    let user = RegKey::predef(HKEY_CURRENT_USER);
    if let Some(enabled) = enabled {
        change_startup(&user, &command, enabled).map_err(|_| "无法更改 Windows 启动项。")?;
    }
    let observed = (|| {
        Ok::<_, io::Error>(read_registration(&user, &command)? && !disabled_by_windows(&user)?)
    })()
    .map_err(|_| "无法读取 Windows 启动项。")?;
    Ok(json!({ "supported": true, "enabled": observed }))
}
