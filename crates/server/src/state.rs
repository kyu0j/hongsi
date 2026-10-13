use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use hongsi_core::models::{Building, MealDay};
use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};

use crate::sessions::Sessions;

pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub static_dir: PathBuf,
    pub secret_file: PathBuf,
    pub seat_poll_secs: u64,
    pub cookie_secure: bool,
}

impl Config {
    pub fn from_env() -> Self {
        use hongsi_config::required_env;

        let bind = required_env("HONGSI_BIND");
        bind.parse::<std::net::SocketAddr>()
            .unwrap_or_else(|_| panic!("HONGSI_BIND에는 IP 주소와 포트가 필요합니다."));
        let database_url = required_env("DATABASE_URL");
        database_url
            .parse::<sqlx::postgres::PgConnectOptions>()
            .unwrap_or_else(|_| panic!("DATABASE_URL 형식이 잘못되었습니다."));
        let seat_poll_secs = required_env("HONGSI_SEAT_POLL_SECS")
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("HONGSI_SEAT_POLL_SECS에는 0 이상의 정수가 필요합니다."));
        let cookie_secure = match required_env("HONGSI_COOKIE_SECURE").as_str() {
            "0" => false,
            "1" => true,
            _ => panic!("HONGSI_COOKIE_SECURE에는 0 또는 1이 필요합니다."),
        };
        Self {
            bind,
            database_url,
            static_dir: PathBuf::from(required_env("HONGSI_STATIC_DIR")),
            secret_file: PathBuf::from(required_env("HONGSI_SECRET_FILE")),
            seat_poll_secs,
            cookie_secure,
        }
    }
}

pub struct SeatSnapshot {
    pub fetched_at: DateTime<Utc>,
    pub checked_at: DateTime<Utc>,
    pub buildings: Vec<Building>,
    pub failed_buildings: Vec<String>,
    pub building_updated_at: HashMap<String, i64>,
}

impl SeatSnapshot {
    pub fn merge(previous: Option<Self>, fresh: Vec<Building>, checked_at: DateTime<Utc>) -> Self {
        let fetched_at = if fresh.is_empty() {
            previous.as_ref().map_or(checked_at, |s| s.fetched_at)
        } else {
            checked_at
        };
        let mut updated = previous.as_ref().map(|s| s.building_updated_at.clone()).unwrap_or_default();
        let mut failed = Vec::new();
        let buildings = hongsi_core::seats::BUILDINGS.iter().map(|(id, name, _)| {
            if let Some(building) = fresh.iter().find(|b| b.id == *id) {
                updated.insert((*id).to_owned(), checked_at.timestamp());
                building.clone()
            } else {
                failed.push((*id).to_owned());
                previous.as_ref().and_then(|s| s.buildings.iter().find(|b| b.id == *id)).cloned()
                    .unwrap_or_else(|| Building { id: (*id).to_owned(), name: (*name).to_owned(), rooms: Vec::new() })
            }
        }).collect();
        Self { fetched_at, checked_at, buildings, failed_buildings: failed, building_updated_at: updated }
    }
}

pub struct AppState {
    pub push: crate::push::Push,
    pub config: Config,
    pub db: PgPool,
    pub sessions: Sessions,
    pub login_attempts: crate::login_limit::LoginAttempts,
    pub http: reqwest::Client,
    pub pepper: Vec<u8>,
    pub meals: Mutex<Option<(Instant, Vec<MealDay>)>>,
    pub seats: RwLock<Option<SeatSnapshot>>,
    pub seat_refresh: Mutex<()>,
    pub submissions: hongsi_core::submission::Jobs,
}

pub type Shared = Arc<AppState>;

pub fn load_secret(path: &Path) -> std::io::Result<Vec<u8>> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        std::io::Error::new(error.kind(), format!("서버 암호화 키 파일을 읽지 못했어요 ({}). HONGSI_SECRET_FILE 경로에 기존 키 파일이 필요합니다.", path.display()))
    })?;
    let bytes = hex::decode(text.trim()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "서버 암호화 키는 16진수 형식이어야 합니다. 기존 키 파일을 확인하세요.")
    })?;
    if bytes.len() < 32 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "서버 암호화 키는 32바이트 이상이어야 합니다. 기존 키 파일을 확인하세요."));
    }
    Ok(bytes)
}
