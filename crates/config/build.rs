use std::{collections::BTreeMap, path::Path};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let groups: serde_json::Value =
        serde_json::from_str(include_str!("url-keys.json")).expect("URL 변수 목록");
    let keys: Vec<&str> = ["public", "server"]
        .into_iter()
        .flat_map(|group| {
            groups[group]
                .as_array()
                .expect("URL 변수 그룹")
                .iter()
                .map(|value| value.as_str().expect("URL 변수명"))
        })
        .collect();
    let mut values = BTreeMap::new();
    println!("cargo:rerun-if-changed=url-keys.json");
    for name in [".env.example", ".env", ".env.server"] {
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        match dotenvy::from_path_iter(&path) {
            Ok(entries) => {
                for entry in entries {
                    let (key, value) =
                        entry.unwrap_or_else(|_| panic!("{name} 형식이 잘못되었습니다."));
                    if keys.contains(&key.as_str()) && !value.trim().is_empty() {
                        values.insert(key, value);
                    }
                }
            }
            Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => panic!("{name} 파일을 읽을 수 없습니다."),
        }
    }
    for key in keys {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| values.remove(key))
            .unwrap_or_else(|| panic!("{key} 주소가 필요합니다."));
        let value = value.trim().trim_end_matches('/');
        let parsed =
            url::Url::parse(value).unwrap_or_else(|_| panic!("{key} 주소 형식이 잘못되었습니다."));
        assert!(
            matches!(parsed.scheme(), "https" | "http")
                && parsed.host_str().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.fragment().is_none()
                && parsed.query().is_none()
                && !value.chars().any(|c| c.is_whitespace() || c.is_control()),
            "{key} 주소 형식이 잘못되었습니다."
        );
        println!("cargo:rustc-env={key}={value}");
    }
}
