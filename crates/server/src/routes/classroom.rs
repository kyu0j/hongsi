use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use hongsi_core::models::{BoardArticle, ModuleContents};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::db;
use crate::error::ApiError;
use crate::state::Shared;

use crate::api::ApiResult;

pub(crate) async fn module_get(user: CurrentUser, Path(cmid): Path<i64>) -> ApiResult<ModuleContents> {
    Ok(Json(user.session.school()?.module_contents(cmid).await?))
}

pub(crate) async fn board_get(user: CurrentUser, Path((cmid, bwid)): Path<(i64, i64)>) -> ApiResult<BoardArticle> {
    Ok(Json(user.session.school()?.board_article(cmid, bwid).await?))
}

pub(crate) async fn notices_seen_get(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let urls = db::notices_seen(&st.db, user.session.user_id).await?;
    Ok(Json(json!({ "urls": urls })))
}

#[derive(Deserialize)]
pub(crate) struct SeenBody {
    urls: Vec<String>,
}

pub(crate) async fn notices_seen_add(State(st): State<Shared>, user: CurrentUser, Json(b): Json<SeenBody>) -> ApiResult<Value> {
    if b.urls.len() > 200 || b.urls.iter().any(|u| u.is_empty() || u.len() > 1000 || !u.starts_with("http")) {
        return Err(ApiError::bad_request("잘못된 알림이에요."));
    }
    if !b.urls.is_empty() {
        db::add_notices_seen(&st.db, user.session.user_id, &b.urls).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn find_assignment(user: &CurrentUser, cmid: i64) -> Result<hongsi_core::models::Assignment, ApiError> {
    Ok(user.session.school()?.assignment(cmid).await?)
}

pub(crate) fn submission_view(a: &hongsi_core::models::Assignment, info: &hongsi_core::models::SubmissionInfo) -> Value {
    let now = Utc::now().timestamp();
    json!({
        "info": info,
        "config": a.config,
        "due": a.due,
        "cutoff": a.cutoff,
        "late": a.due.is_some_and(|d| now > d),
        "closed": a.cutoff.is_some_and(|c| now > c) || info.locked || !info.can_edit,
    })
}

pub(crate) async fn submission_get(user: CurrentUser, Path(cmid): Path<i64>) -> ApiResult<Value> {
    let a = find_assignment(&user, cmid).await?;
    let info = user.session.school()?.submission_info(a.id).await?;
    Ok(Json(submission_view(&a, &info)))
}

pub(crate) async fn notifications(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let school=user.session.school()?;
    Ok(Json(crate::school_records::read(&st.db,user.session.user_id,&school,"notices",false).await?))
}
