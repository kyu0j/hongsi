use std::sync::{Arc, RwLock};
use std::time::Duration;

use regex::Regex;
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT_LANGUAGE, ORIGIN, REFERER};
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::{CoreError, Result};
use crate::models::AcademicTerm;
use crate::util::looks_like_login;

pub(crate) const UA: &str = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) \
                             Chrome/128.0.0.0 Mobile Safari/537.36";
const TIMEOUT: Duration = Duration::from_secs(20);
static SSO_CHECK: hongsi_config::UrlSetting = hongsi_config::UrlSetting::new("HONGSI_SSO_URL", "/login/LoginCheck_SSO.php");
static SSO_EXEC: hongsi_config::UrlSetting = hongsi_config::UrlSetting::new("HONGSI_SSO_URL", "/login/LoginExec3.php");

fn clients() -> Result<(Arc<Jar>, Client, Client)> {
    let jar = Arc::new(Jar::default());
    let builder = || Client::builder().user_agent(UA).timeout(TIMEOUT).cookie_provider(jar.clone());
    let client = builder().build()?;
    let no_redirect = builder().redirect(Policy::none()).build()?;
    Ok((jar, client, no_redirect))
}

pub(crate) async fn school_text(response: reqwest::Response) -> Result<String> {
    let response = response.error_for_status()?;
    let url = response.url();
    let school_host = [
        hongsi_config::SCHOOL_URL.as_str(), hongsi_config::SSO_URL.as_str(),
        hongsi_config::PORTAL_URL.as_str(), hongsi_config::CLASSROOM_URL.as_str(),
        hongsi_config::ATTENDANCE_URL.as_str(), hongsi_config::CLASSNET_URL.as_str(),
    ].iter().any(|base| Url::parse(base).is_ok_and(|base| base.host_str() == url.host_str()));
    if school_host && matches!(url.path(), "/login.jsp" | "/login.do" | "/my/login.do" | "/login/login.jsp") {
        return Err(CoreError::SessionExpired);
    }
    let body = response.text().await?;
    if looks_like_login(&body) {
        return Err(CoreError::SessionExpired);
    }
    Ok(body)
}

fn add_sso_cookies(jar: &Jar, cookies: &[(String, String)]) {
    let origin = Url::parse(hongsi_config::SCHOOL_URL.as_str()).expect("학교 주소");
    let domain = origin.host_str().expect("학교 도메인");
    let domain = domain.strip_prefix("www.").unwrap_or(domain);
    for (name, value) in cookies {
        jar.add_cookie_str(&format!("{name}={value}; Domain=.{domain}; Path=/"), &origin);
    }
}

pub fn public_client() -> Client {
    Client::builder()
        .user_agent(UA)
        .timeout(TIMEOUT)
        .build()
        .expect("HTTP 클라이언트 생성")
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct MoodleAuth {
    pub token: String,
    pub private_token: Option<String>,
    pub user_id: i64,
    pub full_name: String,
    pub picture_url: Option<String>,
    pub department: Option<String>,
}

fn service_origins() -> [String; 4] {
    [hongsi_config::CLASSROOM_URL.as_str(), hongsi_config::ATTENDANCE_URL.as_str(),
        hongsi_config::PORTAL_URL.as_str(), hongsi_config::CLASSNET_URL.as_str()]
        .map(|base| format!("{base}/"))
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ServiceCookies {
    origin: String,
    cookies: Vec<(String, String)>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct SchoolSessionSnapshot {
    version: u8,
    sso_cookies: Vec<(String, String)>,
    pub(crate) moodle: Option<MoodleAuth>,
    service_cookies: Vec<ServiceCookies>,
    current_term: Option<AcademicTerm>,
}

pub struct SchoolSession {
    pub(crate) cookie_jar: Arc<Jar>,
    pub(crate) client: Client,
    pub(crate) no_redirect: Client,
    pub(crate) attendance_ready: OnceCell<()>,
    pub(crate) calendar_school_cache: crate::calendar_cache::SchoolCalendarCache,
    pub(crate) assignment_budget: tokio::sync::Semaphore,
    pub(crate) enrolled_courses: tokio::sync::Mutex<Option<(std::time::Instant, Vec<crate::timetable::EnrolledCourse>)>>,
    pub(crate) attendance_forms: OnceCell<Vec<Vec<(String, String)>>>,
    pub(crate) moodle_web_ready: OnceCell<()>,
    pub(crate) moodle: OnceCell<MoodleAuth>,
    pub(crate) current_term: RwLock<Option<AcademicTerm>>,
    sso_cookies: Vec<(String, String)>,
}

impl SchoolSession {
    pub async fn login(user_id: &str, password: &str) -> Result<Self> {
        let (jar, client, no_redirect) = clients()?;

        let form = [("USER_ID", user_id), ("PASSWD", password)];
        client
            .get(format!("{}/my/login.do", hongsi_config::PORTAL_URL))
            .header(ACCEPT_LANGUAGE, "ko-KR,ko;q=0.9")
            .send()
            .await?;

        let check_text = client.post(SSO_CHECK.as_str()).form(&form).send().await?.text().await?;
        let check: Value = serde_json::from_str(check_text.trim())
            .map_err(|_| CoreError::Parse("SSO 인증 응답".into()))?;
        if check.get("result_code").and_then(Value::as_str) != Some("Y") {
            let message = check
                .get("result_msg")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or("");
            return Err(CoreError::LoginRejected(crate::error::login_rejection_message(message).into()));
        }

        let body = client
            .post(SSO_EXEC.as_str())
            .form(&form)
            .header(REFERER, format!("{}/login/login.jsp", hongsi_config::SSO_URL))
            .header(ORIGIN, hongsi_config::SSO_URL.as_str())
            .send()
            .await?
            .text()
            .await?;
        let pattern = Regex::new(r"SetCookie\s*\(\s*'([^']+)'\s*,\s*'([^']*)'").expect("정규식");
        let cookies: Vec<(String, String)> =
            pattern.captures_iter(&body).map(|cap| (cap[1].to_string(), cap[2].to_string())).collect();
        if cookies.is_empty() {
            return Err(CoreError::Parse("SSO 세션 쿠키".into()));
        }
        add_sso_cookies(&jar, &cookies);
        tracing::debug!(cookies = cookies.len(), "SSO 로그인 성공");
        Ok(Self::with_cookies(jar, client, no_redirect, cookies))
    }

    fn with_cookies(cookie_jar: Arc<Jar>, client: Client, no_redirect: Client, sso_cookies: Vec<(String, String)>) -> Self {
        Self {
            cookie_jar,
            client,
            no_redirect,
            attendance_ready: OnceCell::new(),
            calendar_school_cache: Default::default(),
            assignment_budget: tokio::sync::Semaphore::new(8),
            attendance_forms: OnceCell::new(),
            enrolled_courses: tokio::sync::Mutex::new(None),
            moodle_web_ready: OnceCell::new(),
            moodle: OnceCell::new(),
            current_term: RwLock::new(None),
            sso_cookies,
        }
    }

    pub fn from_sso_cookies(cookies: Vec<(String, String)>) -> Result<Self> {
        let (jar, client, no_redirect) = clients()?;
        add_sso_cookies(&jar, &cookies);
        Ok(Self::with_cookies(jar, client, no_redirect, cookies))
    }

    pub fn sso_cookies(&self) -> &[(String, String)] {
        &self.sso_cookies
    }

    pub fn snapshot(&self) -> SchoolSessionSnapshot {
        let service_cookies = service_origins().iter().filter_map(|origin| {
            let url = Url::parse(origin).ok()?;
            let header = self.cookie_jar.cookies(&url)?;
            let mut cookies: Vec<(String, String)> = header.to_str().ok()?.split(';').filter_map(|pair| {
                let (name, value) = pair.trim().split_once('=')?;
                if self.sso_cookies.iter().any(|(key, _)| key == name) { return None; }
                Some((name.to_string(), value.to_string()))
            }).collect();
            cookies.sort();
            (!cookies.is_empty()).then(|| ServiceCookies { origin: origin.to_string(), cookies })
        }).collect();
        SchoolSessionSnapshot { version: 1, sso_cookies: self.sso_cookies.clone(), moodle: self.moodle.get().cloned(), service_cookies,
            current_term: *self.current_term.read().expect("학기 잠금") }
    }

    pub fn from_snapshot(snapshot: SchoolSessionSnapshot) -> Result<Self> {
        let valid_token = |token: &str| !token.is_empty() && token.len() <= 128 && token.bytes().all(|b| b.is_ascii_alphanumeric());
        let invalid_cookie = |(name, value): &(String, String)| {
            name.is_empty() || name.len() > 100 || value.len() > 8000
                || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                || value.bytes().any(|b| b.is_ascii_control() || b == b';')
        };
        if snapshot.version != 1 || snapshot.sso_cookies.is_empty() || snapshot.sso_cookies.len() > 30
            || snapshot.sso_cookies.iter().any(invalid_cookie)
            || snapshot.service_cookies.len() > service_origins().len()
            || snapshot.service_cookies.iter().any(|service| {
                !service_origins().contains(&service.origin) || service.cookies.len() > 50
                    || service.cookies.iter().any(invalid_cookie)
            })
            || snapshot.moodle.as_ref().is_some_and(|auth| {
                !valid_token(&auth.token) || auth.private_token.as_deref().is_some_and(|token| !valid_token(token)) || auth.user_id <= 0
            })
        {
            return Err(CoreError::Parse("저장된 학교 세션".into()));
        }
        let mut session = Self::from_sso_cookies(snapshot.sso_cookies)?;
        session.current_term = RwLock::new(snapshot.current_term.filter(|term| term.valid()));
        session.moodle = OnceCell::new_with(snapshot.moodle);
        for service in snapshot.service_cookies {
            let origin = Url::parse(&service.origin).map_err(|_| CoreError::Parse("저장된 학교 주소".into()))?;
            for (name, value) in service.cookies {
                session.cookie_jar.add_cookie_str(&format!("{name}={value}; Path=/; Secure"), &origin);
            }
        }
        Ok(session)
    }

    pub(crate) async fn get_text(&self, url: &str, referer: Option<&str>) -> Result<String> {
        let mut req = self.client.get(url);
        if let Some(referer) = referer {
            req = req.header(REFERER, referer);
        }
        school_text(req.send().await?).await
    }

    pub(crate) async fn post_form_text(
        &self,
        url: &str,
        form: &[(String, String)],
        referer: Option<&str>,
    ) -> Result<String> {
        let mut req = self.client.post(url).form(form);
        if let Some(referer) = referer {
            req = req.header(REFERER, referer);
        }
        school_text(req.send().await?).await
    }
}
