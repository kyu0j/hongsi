use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Manager, Wry};
use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use super::SavedDownload;

struct External(tauri::plugin::PluginHandle<Wry>);

struct StagedDownload(PathBuf);
impl Drop for StagedDownload {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

#[derive(Deserialize)]
struct CheckedDownloads { files: Vec<Option<SavedDownload>> }

pub async fn save_download(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<SavedDownload, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let failed = || "파일을 저장하지 못했어요.".to_string();
    let dir = app.path().app_cache_dir().map_err(|_| failed())?.join("download-staging");
    std::fs::create_dir_all(&dir).map_err(|_| failed())?;
    let time = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| failed())?.as_nanos();
    let path = dir.join(format!("{time}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| failed())?;
    let staged = StagedDownload(path);
    file.write_all(bytes).map_err(|_| failed())?;
    drop(file);
    let result: SavedDownload = app.state::<External>().0.run_mobile_plugin_async("saveDownload",
        serde_json::json!({"path": staged.0.to_string_lossy(), "name": name})).await.map_err(|error| {
            if let tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) = error {
                if response.message.as_deref() == Some("파일 저장 권한을 허용해 주세요.") {
                    return "파일 저장 권한을 허용해 주세요.".to_string();
                }
            }
            failed()
        })?;
    Ok(result)
}

pub async fn check_downloads(app: &AppHandle, paths: Vec<Option<String>>) -> Result<Vec<Option<SavedDownload>>, String> {
    let result: CheckedDownloads = app.state::<External>().0.run_mobile_plugin_async("checkDownloads",
        serde_json::json!({"paths": paths})).await.map_err(|_| "파일을 확인하지 못했어요.".to_string())?;
    Ok(result.files)
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("external")
        .setup(|app, api| {
            app.manage(External(api.register_android_plugin("dev.kyuyoung.hongsi", "ExternalPlugin")?));
            Ok(())
        }).build()
}

pub async fn open(app: &AppHandle, command: &str, value: &str) -> Result<(), String> {
    app.state::<External>().0.run_mobile_plugin_async::<serde_json::Value>(command, serde_json::json!({ "value": value })).await
        .map(|_| ()).map_err(|e| {
            if let tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) = e {
                if let Some(message) = response.message {
                    if matches!(message.as_str(),
                        "파일이 없어요." | "파일이나 링크를 열지 못했어요." |
                        "링크를 열 브라우저가 없어요." | "이 파일 형식을 열 수 있는 앱이 없어요." |
                        "파일 앱을 열지 못했어요." | "위젯 테마를 적용하지 못했어요." |
                        "위젯 정보를 저장하지 못했어요."
                    ) { return message; }
                }
            }
            match command {
                "setWidgetTheme" => "위젯 테마를 적용하지 못했어요.",
                "syncWidget" => "위젯 정보를 저장하지 못했어요.",
                "revealFile" => "폴더를 열지 못했어요.",
                _ => "파일이나 링크를 열지 못했어요.",
            }.to_string()
        })
}

pub async fn take_widget_intent(app: &AppHandle) -> Result<serde_json::Value, String> {
    app.state::<External>().0.run_mobile_plugin_async("takeWidgetIntent", ()).await.map_err(|_| "위젯을 새로고침해 주세요.".to_string())
}

pub async fn location_permission(app: &AppHandle, action: &str) -> Result<serde_json::Value, String> {
    app.state::<External>().0.run_mobile_plugin_async("locationPermission", serde_json::json!({"value": action}))
        .await.map_err(|_| "위치 권한을 확인하지 못했어요.".to_string())
}

pub async fn map_tracking(app: &AppHandle, args: serde_json::Value) -> Result<serde_json::Value, String> {
    app.state::<External>().0.run_mobile_plugin_async("mapTracking", args).await.map_err(|error| {
        if let tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) = error {
            if let Some(message) = response.message { return message; }
        }
        "위치를 확인하지 못했어요.".into()
    })
}
