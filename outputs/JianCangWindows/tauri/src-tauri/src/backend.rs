use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::http::{header, Method, Request, Response, StatusCode};

const MAX_HANDSHAKE: u64 = 4096;
const MAX_STATE: usize = 64 * 1024 * 1024;
const MAX_MEDIA: usize = 96 * 1024 * 1024;
const MEDIA_CHUNK: u64 = 8 * 1024 * 1024;

pub struct Backend {
    child: Mutex<Child>,
    client: reqwest::Client,
    base: String,
    token: String,
}

#[derive(Deserialize)]
struct Handshake {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
}

impl Backend {
    pub fn launch(
        root: &Path,
        profile: &Path,
        installed: bool,
        downloads: Option<&Path>,
    ) -> Result<Self, String> {
        let server = root.join("tauri/backend/server.cjs");
        #[cfg(windows)]
        let node = root.join("node.exe");
        #[cfg(not(windows))]
        let node = std::path::PathBuf::from("node");
        if !server.is_file() || (cfg!(windows) && !node.is_file()) {
            return Err("素材库服务文件缺失，请重新解压完整的见藏迁移包。".into());
        }
        std::fs::create_dir_all(profile).map_err(|_| "无法创建见藏的设置文件夹。")?;

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "无法创建素材库服务连接。")?;
        let mut command = Command::new(node);
        command
            .arg(server)
            .arg(profile)
            .arg(env!("CARGO_PKG_VERSION"))
            .arg(if installed { "installed" } else { "portable" })
            .arg(downloads.unwrap_or_else(|| Path::new("")))
            .current_dir(root)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|_| "无法启动见藏素材库服务。")?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (ready, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut buffer = BufReader::new(stdout);
            let mut line = String::new();
            let handshake = buffer
                .by_ref()
                .take(MAX_HANDSHAKE)
                .read_line(&mut line)
                .ok()
                .filter(|count| *count > 0 && (*count as u64) < MAX_HANDSHAKE)
                .and_then(|_| serde_json::from_str::<Handshake>(&line).ok());
            let _ = ready.send(handshake);
            let _ = std::io::copy(&mut buffer, &mut std::io::sink());
        });
        let handshake = receiver
            .recv_timeout(Duration::from_secs(15))
            .ok()
            .flatten()
            .filter(|value| {
                value.port != 0
                    && value.token.len() == 43
                    && value
                        .token
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            });
        let Some(handshake) = handshake else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("素材库服务未能启动，请关闭见藏后重试。".into());
        };
        Ok(Self {
            child: Mutex::new(child),
            client,
            base: format!("http://127.0.0.1:{}", handshake.port),
            token: handshake.token,
        })
    }

    pub async fn call(&self, name: &str, args: Vec<Value>) -> Result<Value, String> {
        let seconds = match name {
            "video-trim:preview"
            | "video-trim:export"
            | "assets:export-batch"
            | "structured-export:start"
            | "image-conversion:start"
            | "board:export"
            | "suggestion:apply"
            | "local-backup:create"
            | "local-backup:restore"
            | "local-backup:run"
            | "local-backup:restore-snapshot"
            | "windows-update:install"
            | "asset:prepare-drag"
            | "file-transfer:clipboard-path" => 7200,
            "browser-capture:worker-state" | "desktop:status" | "video-trim:status" => 8,
            _ => 180,
        };
        let response = self
            .client
            .post(format!("{}/command", self.base))
            .timeout(Duration::from_secs(seconds))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name, "args": args }))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| "无法连接素材库服务，请重新打开见藏。")?;
        let body = bounded_body(response, MAX_STATE)
            .await
            .map_err(|_| "素材库服务的响应过大或已中断。")?;
        let reply: Reply =
            serde_json::from_slice(&body).map_err(|_| "无法读取素材库服务的响应。")?;
        if reply.ok {
            Ok(reply.value.unwrap_or(Value::Null))
        } else {
            Err(reply.error.unwrap_or_else(|| "素材库操作未完成。".into()))
        }
    }

    pub async fn media(&self, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
        let path = request.uri().path();
        if !valid_media_path(path) {
            return Err(StatusCode::NOT_FOUND);
        }
        let mut forward = self
            .client
            .request(
                request.method().clone(),
                format!("{}/media{path}", self.base),
            )
            .bearer_auth(&self.token);
        if let Some(range) = media_range(request) {
            forward = forward.header(header::RANGE, range);
        }
        let response = forward.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        let mut result = Response::builder().status(response.status());
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::CONTENT_SECURITY_POLICY,
            header::CONTENT_DISPOSITION,
        ] {
            if let Some(value) = response.headers().get(&name) {
                result = result.header(name, value);
            }
        }
        let bytes = if request.method() == Method::HEAD {
            Vec::new()
        } else {
            bounded_body(response, MAX_MEDIA).await?
        };
        result.body(bytes).map_err(|_| StatusCode::BAD_GATEWAY)
    }
}

fn media_range(request: &Request<Vec<u8>>) -> Option<header::HeaderValue> {
    let supplied = request.headers().get(header::RANGE);
    if request.method() != Method::GET {
        return supplied.cloned();
    }
    let stream = request.uri().path().starts_with("/video/")
        || request.uri().path().starts_with("/trim-preview/")
        || request.uri().path().starts_with("/live-motion/")
        || request
            .uri()
            .query()
            .is_some_and(|query| query.split('&').any(|part| part.starts_with("media=")));
    if let Some(value) = supplied {
        // Keep exact small PDF ranges and suffix ranges. Open-ended video
        // ranges continue as the browser asks for subsequent byte offsets.
        let parsed = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.split_once('-'));
        if stream {
            if let Some((start, end)) = parsed {
                if let Ok(start) = start.parse::<u64>() {
                    let limit = start.saturating_add(MEDIA_CHUNK - 1);
                    if end.is_empty() || end.parse::<u64>().is_ok_and(|last| last > limit) {
                        return format!("bytes={start}-{limit}").parse().ok();
                    }
                }
            }
        }
        Some(value.clone())
    } else if stream {
        format!("bytes=0-{}", MEDIA_CHUNK - 1).parse().ok()
    } else {
        None
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            drop(child.stdin.take());
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while std::time::Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, StatusCode> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut bytes = Vec::new();
    while let Some(piece) = response
        .chunk()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
    {
        if piece.len() > limit - bytes.len() {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        bytes.extend_from_slice(&piece);
    }
    Ok(bytes)
}

fn valid_media_path(path: &str) -> bool {
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    let mut fields = path.split('/');
    let (Some(role), Some(library), Some(asset), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return false;
    };
    let asset_length = match role {
        "import-thumbnail" => 32,
        "thumbnail"
            | "original"
            | "video"
            | "live-motion"
            | "board-image"
            | "palette-image"
            | "edit-image"
            | "pdf-original"
            | "text-preview"
            | "trim-preview" => 64,
        _ => return false,
    };
    !library.is_empty()
        && library.len() <= 64
        && library
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        && asset.len() == asset_length
        && asset.bytes().all(|byte| byte.is_ascii_hexdigit())
}
