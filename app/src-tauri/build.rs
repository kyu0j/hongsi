fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        assert!(
            hongsi_config::API_URL.as_str().starts_with("https://"),
            "release 빌드의 HONGSI_API_URL은 HTTPS여야 합니다."
        );
    }
    tauri_build::build()
}
