use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::Utc;
use hongsi_core::models::SemesterDisplay;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::calendar::{self, CalendarData};
use crate::db;
use crate::error::ApiError;
use crate::state::Shared;

use crate::api::ApiResult;

#[derive(Deserialize)]
pub(crate) struct CalendarQuery {
    refresh: Option<u8>,
    #[serde(default)]
    semester: SemesterDisplay,
}

pub(crate) async fn calendar_data(State(st): State<Shared>, user: CurrentUser, Query(q): Query<CalendarQuery>) -> ApiResult<Value> {
    let kind=if q.semester.enabled()==SemesterDisplay::All { "archive" } else { "calendar" };
    let school=user.session.school()?;
    let refresh = if q.refresh == Some(1) { crate::school_records::Refresh::Manual } else { crate::school_records::Refresh::Cached };
    crate::school_records::read(&st.db,user.session.user_id,&school,"calendar",refresh).await?;
    if kind == "archive" {
        crate::school_records::read(&st.db,user.session.user_id,&school,kind,false).await?;
    }
    Ok(Json(crate::school_records::rendered(&st.db,user.session.user_id,kind).await?))
}

pub(crate) async fn calendar_state_get(State(st): State<Shared>, user: CurrentUser) -> ApiResult<calendar::CalendarState> {
    Ok(Json(calendar::load_state(&st.db, user.session.user_id).await?))
}

pub(crate) async fn archive_get(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let data = match calendar::archive::load(&st.db, user.session.user_id).await? {
        Some(record) if record.initialized => Some(calendar::archive::render(&st.db, user.session.user_id, record).await?),
        _ => None,
    };
    Ok(Json(json!({ "data": data })))
}

pub(crate) async fn archive_update(State(st): State<Shared>, user: CurrentUser, Query(q): Query<CalendarQuery>) -> ApiResult<Value> {
    let school=user.session.school()?;
    crate::school_records::read(&st.db,user.session.user_id,&school,"archive",q.refresh==Some(1)).await?;
    let kind=if q.semester.enabled()==SemesterDisplay::Current {"calendar"}else{"archive"};
    Ok(Json(crate::school_records::rendered(&st.db,user.session.user_id,kind).await?))
}

pub(crate) async fn archive_put(State(st): State<Shared>, user: CurrentUser, Query(q): Query<CalendarQuery>,
    Json(raw): Json<hongsi_core::calendar_cache::SchoolCalendarData>) -> ApiResult<CalendarData> {
    if raw.courses.len() > 200 || raw.assignments.len() > 3000 || raw.vods.len() > 6000 {
        return Err(ApiError::bad_request("요청이 너무 커요."));
    }
    if let Some(token) = crate::school_records::begin(&st.db, user.session.user_id, "archive", q.refresh == Some(1)).await? {
        crate::school_records::finish(&st.db, user.session.user_id, "archive", &token, Some(json!(raw)), None).await?;
    }
    let record = calendar::archive::load(&st.db, user.session.user_id).await?
        .ok_or_else(|| ApiError::not_found("저장된 학교 정보가 없어요."))?;
    let data = calendar::archive::render(&st.db, user.session.user_id, record).await?;
    *user.session.calendar_cache.lock().await = Default::default();
    calendar::sync_parents(&st.db, &user.session, data.items.iter().map(calendar::TodoParent::from).collect()).await?;
    Ok(Json(data))
}

#[derive(Deserialize)]
pub(crate) struct StateBody {
    #[serde(default, rename = "currentTerm")]
    current_term: Option<hongsi_core::models::AcademicTerm>,
    #[serde(default)]
    courses: Vec<hongsi_core::models::Course>,
    #[serde(default)]
    assignments: Vec<hongsi_core::models::Assignment>,
    #[serde(default)]
    vods: Vec<hongsi_core::models::Vod>,
    #[serde(default)]
    parents: Vec<calendar::TodoParent>,
    #[serde(default, rename = "failedCourseIds")]
    failed_course_ids: Vec<i64>,
}

pub(crate) async fn calendar_state(State(st): State<Shared>, user: CurrentUser, Json(mut b): Json<StateBody>) -> ApiResult<Value> {
    if b.courses.len() > 200 || b.assignments.len() > 3000 || b.vods.len() > 6000 || b.parents.len() > 6000 || b.failed_course_ids.len() > 200 {
        return Err(ApiError::bad_request("요청이 너무 커요."));
    }
    if b.parents
        .iter()
        .any(|p| p.key.len() > 300 || !(p.key.starts_with("assign:") || p.key.starts_with("vod:")))
    {
        return Err(ApiError::bad_request("잘못된 연결 항목이에요."));
    }
    if !b.courses.is_empty() {
        *user.session.device_courses.lock().expect("세션 잠금") = b.courses.iter().map(|c| c.id).collect();
    }
    let mut preserved = None;
    if b.current_term.is_some() {
        let mut current = hongsi_core::calendar_cache::SchoolCalendarData {
            current_term: b.current_term, courses: b.courses.clone(), assignments: b.assignments.clone(), vods: b.vods.clone(),
            failed_course_ids: b.failed_course_ids.clone(),
        };
        if let Some(token) = crate::school_records::begin(&st.db, user.session.user_id, "calendar", false).await? {
            crate::school_records::finish(&st.db, user.session.user_id, "calendar", &token, Some(json!(current)), None).await?;
        }
        current = serde_json::from_value(crate::school_records::raw(&st.db, user.session.user_id, "calendar").await?)
            .map_err(|_| ApiError::bad_request("학교 정보를 확인해 주세요."))?;
        b.assignments = current.assignments.clone();
        b.vods = current.vods.clone();
        if !current.failed_course_ids.is_empty() {
            b.assignments = current.assignments.clone();
            b.vods = current.vods.clone();
            preserved = Some(current);
        }
    }
    let snapshots = db::sync_assignments(&st.db, user.session.user_id, &b.assignments).await?;
    let checks = db::item_checks(&st.db, user.session.user_id).await?;
    let alerts_off = db::item_alerts_off(&st.db, user.session.user_id).await?;
    let alert_leads = db::item_alert_leads(&st.db, user.session.user_id).await?;
    let snapshots = calendar::snapshot_infos(snapshots);
    let items = calendar::build(
        &b.assignments,
        &b.vods,
        &snapshots,
        &checks,
        &alerts_off,
        &alert_leads,
        Utc::now().timestamp(),
    );
    let mut parents: Vec<_> = items.iter().map(calendar::TodoParent::from).collect();
    parents.extend(b.parents);
    calendar::sync_parents(&st.db, &user.session, parents).await?;
    Ok(Json(
        json!({ "snapshots": snapshots, "checks": checks, "alertsOff": alerts_off, "alertLeads": alert_leads, "schoolData": preserved }),
    ))
}

#[derive(Deserialize)]
pub(crate) struct CalendarDoneBody {
    #[serde(deserialize_with = "Option::<bool>::deserialize")]
    done: Option<bool>,
}

pub(crate) async fn set_done(
    State(st): State<Shared>,
    user: CurrentUser,
    Path(key): Path<String>,
    Json(b): Json<CalendarDoneBody>,
) -> ApiResult<Value> {
    if key.len() > 300 || !(key.starts_with("assign:") || key.starts_with("vod:")) {
        return Err(ApiError::bad_request("잘못된 항목이에요."));
    }
    match b.done {
        Some(done) => db::set_item_check(&st.db, user.session.user_id, &key, done).await?,
        None => {
            let parent = calendar::parent(&st.db, &user.session, &key).await?;
            db::clear_item_check(&st.db, user.session.user_id, &key, parent.is_some_and(|p| p.finished)).await?;
        }
    }
    user.session.calendar_cache.lock().await.patch_items(&key, |item| {
        item.done = b.done.unwrap_or(item.status == "submitted" || item.status == "done");
        item.done_override = b.done;
    });
    Ok(Json(json!({ "key": key, "done": b.done })))
}

#[derive(Deserialize)]
pub(crate) struct AlertBody {
    on: bool,
}

pub(crate) async fn set_alert(
    State(st): State<Shared>,
    user: CurrentUser,
    Path(key): Path<String>,
    Json(b): Json<AlertBody>,
) -> ApiResult<Value> {
    if key.len() > 300 || !(key.starts_with("assign:") || key.starts_with("vod:")) {
        return Err(ApiError::bad_request("잘못된 항목이에요."));
    }
    db::set_item_alert(&st.db, user.session.user_id, &key, b.on).await?;
    user.session.calendar_cache.lock().await.patch_items(&key, |item| item.alert = b.on);
    Ok(Json(json!({ "key": key, "on": b.on })))
}

#[derive(Deserialize)]
pub(crate) struct AlertLeadsBody {
    leads: Option<Vec<i32>>,
}

pub(crate) async fn set_alert_leads(
    State(st): State<Shared>,
    user: CurrentUser,
    Path(key): Path<String>,
    Json(b): Json<AlertLeadsBody>,
) -> ApiResult<Value> {
    if key.len() > 300 || !(key.starts_with("assign:") || key.starts_with("vod:")) {
        return Err(ApiError::bad_request("잘못된 항목이에요."));
    }
    if b.leads.as_deref().is_some_and(|leads| !calendar::valid_alert_leads(leads)) {
        return Err(ApiError::bad_request("알림 시간이 올바르지 않아요."));
    }
    db::set_item_alert_leads(&st.db, user.session.user_id, &key, b.leads.as_deref()).await?;
    user.session.calendar_cache.lock().await.patch_items(&key, |item| item.alert_leads = b.leads.clone());
    Ok(Json(json!({ "key": key, "leads": b.leads })))
}
