use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Manager, Wry};

struct Updater(tauri::plugin::PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("hongsi-update").setup(|app, api| {
        app.manage(Updater(api.register_android_plugin("dev.kyuyoung.hongsi", "UpdatePlugin")?));
        Ok(())
    }).build()
}

pub async fn call(app: &AppHandle, action: &str, version_code: Option<i64>) -> Result<serde_json::Value, String> {
    if !["check", "status", "install", "permissions"].contains(&action) {
        return Err("지원하지 않는 업데이트 요청이에요.".into());
    }
    app.state::<Updater>().0.run_mobile_plugin_async(action, serde_json::json!({ "versionCode": version_code })).await
        .map_err(|e| {
            if let tauri::plugin::mobile::PluginInvokeError::InvokeRejected(response) = e {
                if let Some(message) = response.message {
                    if matches!(message.as_str(),
                        "APK 파일을 읽지 못했어요." |
                        "APK를 다운로드하지 못했어요." |
                        "업데이트를 설치하지 못했어요." |
                        "업데이트를 확인하지 못했어요." |
                        "업데이트하지 못했어요." |
                        "다운로드 용량이나 대기 시간이 제한을 초과했어요." |
                        "설정에서 홍시의 ‘이 출처 허용’을 켜 주세요." |
                        "설치 화면을 열지 못했어요." |
                        "설치된 홍시와 서명키가 달라 업데이트할 수 없어요." |
                        "업데이트 버전 정보가 올바르지 않아요." |
                        "업데이트 서버 주소를 확인하지 못했어요." |
                        "업데이트 서버에 연결하지 못했어요." |
                        "업데이트 설명이 너무 길어요." |
                        "업데이트 설치를 취소했어요." |
                        "업데이트 정보가 너무 커요." |
                        "최신 버전을 다시 확인해 주세요." |
                        "업데이트 정보가 올바르지 않아요." |
                        "업데이트를 다운로드하지 못했어요." |
                        "업데이트 주소가 올바르지 않아요." |
                        "업데이트 파일을 다시 받아 주세요." |
                        "업데이트 파일 정보가 올바르지 않아요." |
                        "업데이트 파일을 저장하지 못했어요." |
                        "업데이트 파일의 버전 정보가 맞지 않아요." |
                        "업데이트 파일이 너무 커요." |
                        "업데이트가 진행 중이에요." |
                        "업데이트는 안전한 HTTPS 주소에서만 받을 수 있어요." |
                        "업데이트를 진행하지 못했어요." |
                        "지금은 업데이트할 수 없어요." |
                        "홍시 앱의 업데이트 파일이 아니에요."
                    ) { return message; }
                }
            }
            "업데이트를 진행하지 못했어요.".to_string()
        })
}
