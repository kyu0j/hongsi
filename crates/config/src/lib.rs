use std::fmt;
use std::sync::OnceLock;

pub struct UrlSetting {
    key: &'static str,
    path: &'static str,
    value: OnceLock<String>,
}

impl UrlSetting {
    pub const fn new(key: &'static str, path: &'static str) -> Self {
        Self {
            key,
            path,
            value: OnceLock::new(),
        }
    }

    pub fn as_str(&self) -> &str {
        self.value
            .get_or_init(|| format!("{}{}", configured(self.key), self.path))
    }
}

impl fmt::Display for UrlSetting {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

fn compiled(key: &str) -> &'static str {
    match key {
        "HONGSI_API_URL" => env!("HONGSI_API_URL"),
        "HONGSI_REPO_URL" => env!("HONGSI_REPO_URL"),
        "HONGSI_SUPPORT_URL" => env!("HONGSI_SUPPORT_URL"),
        "HONGSI_DEMO_URL" => env!("HONGSI_DEMO_URL"),
        "HONGSI_SCHOOL_URL" => env!("HONGSI_SCHOOL_URL"),
        "HONGSI_SSO_URL" => env!("HONGSI_SSO_URL"),
        "HONGSI_PORTAL_URL" => env!("HONGSI_PORTAL_URL"),
        "HONGSI_CLASSROOM_URL" => env!("HONGSI_CLASSROOM_URL"),
        "HONGSI_ATTENDANCE_URL" => env!("HONGSI_ATTENDANCE_URL"),
        "HONGSI_CLASSNET_URL" => env!("HONGSI_CLASSNET_URL"),
        "HONGSI_FOOD_URL" => env!("HONGSI_FOOD_URL"),
        "HONGSI_SEAT_G_URL" => env!("HONGSI_SEAT_G_URL"),
        "HONGSI_SEAT_T_URL" => env!("HONGSI_SEAT_T_URL"),
        "HONGSI_SEAT_R_URL" => env!("HONGSI_SEAT_R_URL"),
        "HONGSI_STUDENT_CARD_URL" => env!("HONGSI_STUDENT_CARD_URL"),
        "HONGSI_FCM_URL" => env!("HONGSI_FCM_URL"),
        "HONGSI_FCM_TOKEN_URL" => env!("HONGSI_FCM_TOKEN_URL"),
        "HONGSI_FCM_SCOPE" => env!("HONGSI_FCM_SCOPE"),
        "HONGSI_APNS_URL" => env!("HONGSI_APNS_URL"),
        "HONGSI_APNS_SANDBOX_URL" => env!("HONGSI_APNS_SANDBOX_URL"),
        _ => panic!("정의되지 않은 URL 변수입니다."),
    }
}

fn configured(key: &str) -> String {
    let value = std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| compiled(key).into());
    value.trim().trim_end_matches('/').to_string()
}

pub fn required_env(key: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| panic!("{key} 환경변수가 없거나 비어 있습니다."))
        .trim()
        .to_string()
}

pub fn validate() -> Result<(), Box<dyn std::error::Error>> {
    let groups: [&[&str]; 2] = [
        &[
            "HONGSI_API_URL",
            "HONGSI_REPO_URL",
            "HONGSI_SUPPORT_URL",
            "HONGSI_DEMO_URL",
            "HONGSI_SCHOOL_URL",
            "HONGSI_SSO_URL",
            "HONGSI_PORTAL_URL",
            "HONGSI_CLASSROOM_URL",
            "HONGSI_ATTENDANCE_URL",
            "HONGSI_CLASSNET_URL",
            "HONGSI_FOOD_URL",
            "HONGSI_SEAT_G_URL",
            "HONGSI_SEAT_T_URL",
            "HONGSI_SEAT_R_URL",
            "HONGSI_STUDENT_CARD_URL",
        ],
        &[
            "HONGSI_FCM_URL",
            "HONGSI_FCM_TOKEN_URL",
            "HONGSI_FCM_SCOPE",
            "HONGSI_APNS_URL",
            "HONGSI_APNS_SANDBOX_URL",
        ],
    ];
    for key in groups.into_iter().flatten() {
        let value = required_env(key);
        let valid = url::Url::parse(&value).is_ok_and(|url| {
            matches!(url.scheme(), "https" | "http")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        }) && !value.chars().any(|c| c.is_whitespace() || c.is_control());
        if !valid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{key} 주소 형식이 잘못되었습니다."),
            )
            .into());
        }
    }
    if repository().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "HONGSI_REPO_URL에는 GitHub 저장소 주소가 필요합니다.",
        )
        .into());
    }
    Ok(())
}

pub fn repository() -> Option<String> {
    let url = url::Url::parse(REPO_URL.as_str()).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
        })
    {
        return None;
    }
    Some(parts.join("/"))
}

pub static API_URL: UrlSetting = UrlSetting::new("HONGSI_API_URL", "");
pub static REPO_URL: UrlSetting = UrlSetting::new("HONGSI_REPO_URL", "");
pub static SUPPORT_URL: UrlSetting = UrlSetting::new("HONGSI_SUPPORT_URL", "");
pub static DEMO_URL: UrlSetting = UrlSetting::new("HONGSI_DEMO_URL", "");
pub static SCHOOL_URL: UrlSetting = UrlSetting::new("HONGSI_SCHOOL_URL", "");
pub static SSO_URL: UrlSetting = UrlSetting::new("HONGSI_SSO_URL", "");
pub static PORTAL_URL: UrlSetting = UrlSetting::new("HONGSI_PORTAL_URL", "");
pub static CLASSROOM_URL: UrlSetting = UrlSetting::new("HONGSI_CLASSROOM_URL", "");
pub static ATTENDANCE_URL: UrlSetting = UrlSetting::new("HONGSI_ATTENDANCE_URL", "");
pub static CLASSNET_URL: UrlSetting = UrlSetting::new("HONGSI_CLASSNET_URL", "");
pub static FOOD_URL: UrlSetting = UrlSetting::new("HONGSI_FOOD_URL", "");
pub static SEAT_G_URL: UrlSetting = UrlSetting::new("HONGSI_SEAT_G_URL", "");
pub static SEAT_T_URL: UrlSetting = UrlSetting::new("HONGSI_SEAT_T_URL", "");
pub static SEAT_R_URL: UrlSetting = UrlSetting::new("HONGSI_SEAT_R_URL", "");
pub static STUDENT_CARD_URL: UrlSetting = UrlSetting::new("HONGSI_STUDENT_CARD_URL", "");
pub static FCM_URL: UrlSetting = UrlSetting::new("HONGSI_FCM_URL", "");
pub static FCM_TOKEN_URL: UrlSetting = UrlSetting::new("HONGSI_FCM_TOKEN_URL", "");
pub static FCM_SCOPE: UrlSetting = UrlSetting::new("HONGSI_FCM_SCOPE", "");
pub static APNS_URL: UrlSetting = UrlSetting::new("HONGSI_APNS_URL", "");
pub static APNS_SANDBOX_URL: UrlSetting = UrlSetting::new("HONGSI_APNS_SANDBOX_URL", "");
