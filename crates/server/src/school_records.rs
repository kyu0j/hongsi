use crate::{auth::CurrentUser, calendar, error::ApiError, state::Shared};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::Utc;
use hongsi_core::{
    calendar_cache::SchoolCalendarData,
    models::{Notification, SemesterDisplay, Timetable},
    SchoolSession,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{types::Json as DbJson, PgPool};
use std::time::Duration;

#[derive(sqlx::FromRow)]
struct Record {
    data: Value,
    metadata: Value,
}
pub enum Access {
    Ready,
    Fetch(String),
    Waiting,
}
fn valid(kind: &str) -> bool {
    matches!(kind, "calendar" | "archive" | "timetable" | "notices")
}
fn stored_error(code: &str) -> ApiError {
    match code {
        "session_expired" => hongsi_core::CoreError::SessionExpired.into(),
        "classroom_token_expired" => hongsi_core::CoreError::ClassroomTokenExpired.into(),
        _ => ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "school_unreachable",
            "학교 정보를 불러오지 못했어요.",
        ),
    }
}
pub async fn acquire(
    db: &PgPool,
    uid: i64,
    kind: &str,
    refresh: bool,
    started: i64,
) -> Result<Access, ApiError> {
    let mut tx = db.begin().await?;
    sqlx::query("insert into school_records(user_id) values($1) on conflict do nothing")
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    let record: Record =
        sqlx::query_as("select data,metadata from school_records where user_id=$1 for update")
            .bind(uid)
            .fetch_one(&mut *tx)
            .await?;
    let now = Utc::now().timestamp_millis();
    let meta = &record.metadata[kind];
    let paired = match kind {
        "calendar" => "archive",
        "archive" => "calendar",
        _ => kind,
    };
    if meta["until"].as_i64().unwrap_or(0) > now
        || record.metadata[paired]["until"].as_i64().unwrap_or(0) > now
    {
        return Ok(Access::Waiting);
    }
    let attempted = meta["attemptAt"].as_i64().unwrap_or(0);
    let success = meta["successAt"].as_i64().unwrap_or(0);
    let error = meta["error"].as_str();
    let static_data = matches!(kind, "archive" | "timetable");
    if !refresh && static_data && success > 0 {
        return Ok(Access::Ready);
    }
    let fresh = success > 0 && error.is_none() && now - attempted < 300_000;
    let shared = attempted >= started && (success >= attempted || error.is_some());
    if (!refresh && fresh) || shared || (!refresh && now - attempted < 300_000) {
        if let Some(code) = error {
            if success == 0 || matches!(code, "session_expired" | "classroom_token_expired") {
                return Err(stored_error(code));
            }
        }
        if success > 0 {
            return Ok(Access::Ready);
        }
    }
    let token = hex::encode(rand::random::<[u8; 16]>());
    let mut meta = if meta.is_object() {
        meta.clone()
    } else {
        json!({})
    };
    meta["attemptAt"] = json!(now);
    meta["until"] = json!(now + 120_000);
    meta["token"] = json!(token);
    meta.as_object_mut().unwrap().remove("error");
    sqlx::query(
        "update school_records set metadata=jsonb_set(metadata,array[$2],$3) where user_id=$1",
    )
    .bind(uid)
    .bind(kind)
    .bind(meta)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Access::Fetch(token))
}
pub async fn begin(
    db: &PgPool,
    uid: i64,
    kind: &str,
    refresh: bool,
) -> Result<Option<String>, ApiError> {
    let started = Utc::now().timestamp_millis();
    for _ in 0..520 {
        match acquire(db, uid, kind, refresh, started).await? {
            Access::Ready => return Ok(None),
            Access::Fetch(token) => return Ok(Some(token)),
            Access::Waiting => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
    Err(ApiError::new(
        axum::http::StatusCode::GATEWAY_TIMEOUT,
        "timeout",
        "학교의 응답이 늦어지고 있어요.",
    ))
}
pub async fn catalog(db: &PgPool, uid: i64) -> Result<Option<SchoolCalendarData>, ApiError> {
    Ok(calendar::archive::load(db, uid)
        .await?
        .map(|r| r.school_data.0))
}
pub async fn fetch(
    school: &SchoolSession,
    kind: &str,
    previous: Option<SchoolCalendarData>,
    refresh: bool,
) -> Result<Value, ApiError> {
    match kind {
        "calendar" => {
            let data = if let Some(mut previous) = previous {
                previous.retain_current();
                school
                    .calendar_for_courses(previous.current_term, previous.courses, true)
                    .await?
            } else {
                school
                    .calendar_school(SemesterDisplay::Current, false)
                    .await?
            };
            Ok(json!(data))
        }
        "archive" => Ok(json!(
            school
                .calendar_school(SemesterDisplay::All, refresh)
                .await?
        )),
        "timetable" => Ok(json!(school.timetable().await?)),
        "notices" => Ok(json!(school.recent_notifications().await?)),
        _ => Err(ApiError::bad_request("잘못된 요청이에요.")),
    }
}
pub async fn finish(
    db: &PgPool,
    uid: i64,
    kind: &str,
    token: &str,
    data: Option<Value>,
    error: Option<&str>,
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    crate::todos::lock(&mut tx, uid).await?;
    let mut record: Record =
        sqlx::query_as("select data,metadata from school_records where user_id=$1 for update")
            .bind(uid)
            .fetch_one(&mut *tx)
            .await?;
    let now = Utc::now().timestamp_millis();
    if record.metadata[kind]["token"].as_str() != Some(token)
        || record.metadata[kind]["until"].as_i64().unwrap_or(0) <= now
    {
        return Err(ApiError::conflict("학교 정보를 다시 확인해 주세요."));
    }
    let mut meta = record.metadata[kind].clone();
    let mut changes = serde_json::Map::new();
    meta.as_object_mut().unwrap().remove("token");
    meta.as_object_mut().unwrap().remove("until");
    if let Some(code) = error {
        meta["error"] = json!(
            if matches!(code, "session_expired" | "classroom_token_expired" | "school_changed" | "school_error" | "timeout") {
                code
            } else {
                "school_unreachable"
            }
        );
        if matches!(code, "session_expired" | "classroom_token_expired") {
            meta["attemptAt"] = json!(0);
        }
    } else {
        let data = data.ok_or_else(|| ApiError::bad_request("학교 정보가 없어요."))?;
        let changed = match kind {
            "calendar" | "archive" => {
                let mut raw: SchoolCalendarData = serde_json::from_value(data)
                    .map_err(|_| ApiError::bad_request("학교 정보를 확인해 주세요."))?;
                if raw.courses.len() > 200 || raw.assignments.len() > 3000 || raw.vods.len() > 6000
                {
                    return Err(ApiError::bad_request("요청이 너무 커요."));
                }
                let previous=sqlx::query_as::<_,calendar::archive::Record>("select school_data,updated_at,current_updated_at,initialized from calendar_archives where user_id=$1 for update").bind(uid).fetch_optional(&mut *tx).await?;
                if let Some(ref p) = previous {
                    raw.preserve_failed(&p.school_data.0);
                }
                if kind == "calendar" {
                    if let Some(ref p) = previous {
                        let mut all = p.school_data.0.clone();
                        calendar::archive::merge(&mut all, &raw);
                        raw = all;
                    }
                }
                let changed = previous
                    .as_ref()
                    .is_none_or(|p| json!(p.school_data.0) != json!(raw));
                let initialized =
                    kind == "archive" || previous.as_ref().is_some_and(|p| p.initialized);
                let updated = if kind == "archive" {
                    now
                } else {
                    previous.as_ref().map_or(0, |p| p.updated_at)
                };
                sqlx::query("insert into calendar_archives(user_id,school_data,updated_at,current_updated_at,initialized) values($1,$2,$3,$4,$5) on conflict(user_id) do update set school_data=excluded.school_data,updated_at=excluded.updated_at,current_updated_at=excluded.current_updated_at,initialized=excluded.initialized")
                    .bind(uid).bind(DbJson(&raw)).bind(updated).bind(now).bind(initialized).execute(&mut *tx).await?;
                let snapshots =
                    crate::db::sync_assignments_in(&mut tx, uid, &raw.assignments).await?;
                let items = calendar::build(
                    &raw.assignments,
                    &raw.vods,
                    &calendar::snapshot_infos(snapshots),
                    &Default::default(),
                    &Default::default(),
                    &Default::default(),
                    Utc::now().timestamp(),
                );
                crate::todos::sync_parents_in(
                    &mut tx,
                    uid,
                    &items
                        .iter()
                        .map(calendar::TodoParent::from)
                        .collect::<Vec<_>>(),
                )
                .await?;
                if kind == "archive" {
                    changes.insert("calendar".into(),json!({"attemptAt":now,"successAt":now,"revision":record.metadata["calendar"]["revision"].as_i64().unwrap_or(0)+i64::from(changed)}));
                }
                changed
            }
            "timetable" => {
                let parsed: Timetable = serde_json::from_value(data)
                    .map_err(|_| ApiError::bad_request("시간표를 확인해 주세요."))?;
                let value = json!(parsed);
                let changed = record.data[kind] != value;
                record.data[kind] = value;
                changed
            }
            "notices" => {
                let parsed: Vec<Notification> = serde_json::from_value(data)
                    .map_err(|_| ApiError::bad_request("알림을 확인해 주세요."))?;
                if parsed.len() > 1000 {
                    return Err(ApiError::bad_request("요청이 너무 커요."));
                }
                let value = json!(parsed);
                let changed = record.data[kind] != value;
                record.data[kind] = value;
                changed
            }
            _ => return Err(ApiError::bad_request("잘못된 요청이에요.")),
        };
        meta["successAt"] = json!(now);
        meta["revision"] = json!(meta["revision"].as_i64().unwrap_or(0) + i64::from(changed));
        meta.as_object_mut().unwrap().remove("error");
    }
    changes.insert(kind.into(), meta);
    sqlx::query("update school_records set data=$2,metadata=metadata || $3 where user_id=$1")
        .bind(uid)
        .bind(record.data)
        .bind(Value::Object(changes))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn raw(db: &PgPool, uid: i64, kind: &str) -> Result<Value, ApiError> {
    if matches!(kind, "calendar" | "archive") {
        let mut data = catalog(db, uid)
            .await?
            .ok_or_else(|| ApiError::not_found("저장된 학교 정보가 없어요."))?;
        if kind == "calendar" {
            data.retain_current();
        }
        return Ok(json!(data));
    }
    Ok(
        sqlx::query_scalar::<_, Value>("select data->$2 from school_records where user_id=$1")
            .bind(uid)
            .bind(kind)
            .fetch_one(db)
            .await?,
    )
}
pub async fn read(
    db: &PgPool,
    uid: i64,
    school: &SchoolSession,
    kind: &str,
    refresh: bool,
) -> Result<Value, ApiError> {
    if let Some(token) = begin(db, uid, kind, refresh).await? {
        let previous = catalog(db, uid).await?;
        let result = tokio::time::timeout(
            Duration::from_secs(100),
            fetch(school, kind, previous, refresh),
        )
        .await
        .unwrap_or_else(|_| {
            Err(ApiError::new(
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "학교의 응답이 늦어지고 있어요.",
            ))
        });
        match result {
            Ok(data) => finish(db, uid, kind, &token, Some(data), None).await?,
            Err(e) => {
                finish(db, uid, kind, &token, None, Some(e.code)).await?;
                return Err(e);
            }
        }
    }
    raw(db, uid, kind).await
}
pub async fn rendered(db: &PgPool, uid: i64, kind: &str) -> Result<Value, ApiError> {
    if matches!(kind, "calendar" | "archive") {
        let mut record = calendar::archive::load(db, uid)
            .await?
            .ok_or_else(|| ApiError::not_found("저장된 학교 정보가 없어요."))?;
        if kind == "calendar" {
            record.school_data.0.retain_current();
        }
        let mut data = calendar::archive::render(db, uid, record).await?;
        if kind == "calendar" {
            data.semester_display = SemesterDisplay::Current;
        }
        Ok(json!(data))
    } else {
        raw(db, uid, kind).await
    }
}
#[derive(Deserialize)]
pub struct Options {
    #[serde(default)]
    refresh: bool,
    #[serde(default, rename = "currentOnly")]
    current_only: bool,
}
pub async fn start(
    State(st): State<Shared>,
    user: CurrentUser,
    Path(kind): Path<String>,
    Json(options): Json<Options>,
) -> Result<Json<Value>, ApiError> {
    if !valid(&kind) {
        return Err(ApiError::bad_request("잘못된 요청이에요."));
    }
    match begin(&st.db, user.session.user_id, &kind, options.refresh).await? {
        None => Ok(Json(
            json!({"data":rendered(&st.db,user.session.user_id,if kind=="archive" && options.current_only {"calendar"}else{&kind}).await?}),
        )),
        Some(token) => {
            let catalog = catalog(&st.db, user.session.user_id)
                .await?
                .map(|mut data| {
                    data.retain_current();
                    json!({"currentTerm":data.current_term,"courses":data.courses})
                });
            Ok(Json(json!({"token":token,"catalog":catalog})))
        }
    }
}
#[derive(Deserialize)]
pub struct Completion {
    token: String,
    data: Option<Value>,
    error: Option<String>,
    #[serde(default, rename = "currentOnly")]
    current_only: bool,
}
pub async fn complete(
    State(st): State<Shared>,
    user: CurrentUser,
    Path(kind): Path<String>,
    Json(body): Json<Completion>,
) -> Result<Json<Value>, ApiError> {
    if !valid(&kind) {
        return Err(ApiError::bad_request("잘못된 요청이에요."));
    }
    finish(
        &st.db,
        user.session.user_id,
        &kind,
        &body.token,
        body.data,
        body.error.as_deref(),
    )
    .await?;
    if body.error.is_some() {
        return Ok(Json(json!({"ok":true})));
    }
    Ok(Json(
        rendered(
            &st.db,
            user.session.user_id,
            if kind == "archive" && body.current_only {
                "calendar"
            } else {
                &kind
            },
        )
        .await?,
    ))
}
pub async fn revisions(
    State(st): State<Shared>,
    user: CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let metadata: Option<Value> =
        sqlx::query_scalar("select metadata from school_records where user_id=$1")
            .bind(user.session.user_id)
            .fetch_optional(&st.db)
            .await?;
    let versions: serde_json::Map<String, Value> = metadata
        .as_ref()
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(kind, value)| (kind.clone(), json!(value["revision"].as_i64().unwrap_or(0))))
        .collect();
    Ok(Json(Value::Object(versions)))
}
#[derive(Deserialize)]
pub struct StoredQuery {
    #[serde(default)]
    kind: String,
}
pub async fn stored(
    State(st): State<Shared>,
    user: CurrentUser,
    Query(query): Query<StoredQuery>,
) -> Result<Json<Value>, ApiError> {
    if !valid(&query.kind) {
        return Err(ApiError::bad_request("잘못된 요청이에요."));
    }
    Ok(Json(
        rendered(&st.db, user.session.user_id, &query.kind).await?,
    ))
}

