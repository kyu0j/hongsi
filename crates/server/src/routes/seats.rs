use axum::extract::{Query, State};
use axum::Json;
use chrono::{Duration as Span, FixedOffset, TimeZone, Utc};
use hongsi_core::seats::validity_hours;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::db::{self, NewSeatSession, RecentSeat, SeatSession};
use crate::error::ApiError;
use crate::state::{SeatSnapshot, Shared};

use crate::api::ApiResult;

async fn ensure_snapshot(st: &Shared) -> Result<(), ApiError> {
    if st.seats.read().await.as_ref().is_some_and(|s| (Utc::now() - s.checked_at).num_seconds() < 90) {
        return Ok(());
    }
    let _refresh = st.seat_refresh.lock().await;
    if let Some(s) = st.seats.read().await.as_ref() {
        if (Utc::now() - s.checked_at).num_seconds() < 90 {
            return Ok(());
        }
    }
    let result = hongsi_core::seats::fetch_all(&st.http).await;
    let mut snapshot = st.seats.write().await;
    let buildings = match result {
        Ok(buildings) => buildings,
        Err(error) if snapshot.is_none() => return Err(error.into()),
        Err(_) => Vec::new(),
    };
    *snapshot = Some(SeatSnapshot::merge(snapshot.take(), buildings, Utc::now()));
    Ok(())
}

pub(crate) async fn seats(State(st): State<Shared>) -> ApiResult<Value> {
    ensure_snapshot(&st).await?;
    let snap = st.seats.read().await;
    let s = snap.as_ref().ok_or_else(|| ApiError::not_found("좌석 정보를 받지 못했어요."))?;
    Ok(Json(
        json!({ "fetchedAt": s.fetched_at.timestamp(), "watching": st.config.seat_poll_secs > 0, "buildings": s.buildings, "failedBuildings": s.failed_buildings, "buildingUpdatedAt": s.building_updated_at }),
    ))
}

#[derive(Deserialize)]
pub(crate) struct RecentQuery {
    building: String,
    room: i32,
    minutes: Option<i64>,
}

pub(crate) async fn seats_recent(State(st): State<Shared>, Query(q): Query<RecentQuery>) -> ApiResult<Vec<RecentSeat>> {
    let minutes = q.minutes.unwrap_or(15).clamp(1, 120);
    Ok(Json(
        db::recent_assigned(&st.db, &q.building, q.room, Utc::now() - Span::minutes(minutes)).await?,
    ))
}

async fn seat_info(st: &Shared, building: &str, room_no: i32, seat_no: i32) -> Option<(String, String)> {
    let snap = st.seats.read().await;
    let b = snap.as_ref()?.buildings.iter().find(|b| b.id == building)?;
    let room = b.rooms.iter().find(|r| r.no as i32 == room_no)?;
    let state = room.grid.iter().flatten().flatten().find(|c| c.no as i32 == seat_no)?.state;
    Some((room.name.clone(), state.as_str().to_string()))
}

fn building_name(id: &str) -> &'static str {
    hongsi_core::seats::BUILDINGS
        .iter()
        .find(|(b, _, _)| *b == id)
        .map(|(_, name, _)| *name)
        .unwrap_or("")
}

fn normalize_period(period: Option<&str>) -> &'static str {
    match period {
        Some("exam") => "exam",
        Some("vacation") => "vacation",
        _ => "semester",
    }
}

async fn view(st: &Shared, s: SeatSession) -> Value {
    let failed = st.seats.read().await.as_ref().is_some_and(|snapshot| snapshot.failed_buildings.contains(&s.building));
    let seat_state = if failed { None } else {
        seat_info(st, &s.building, s.room_no, s.seat_no).await.map(|(_, state)| state)
    };
    let mut v = serde_json::to_value(&s).unwrap_or_else(|_| json!({}));
    v["seatState"] = json!(seat_state);
    v["validityHours"] = json!(validity_hours(&s.period));
    v["buildingName"] = json!(building_name(&s.building));
    v
}

pub(crate) async fn seat_session(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let _ = ensure_snapshot(&st).await;
    let session = db::active_seat_session(&st.db, user.session.user_id).await?;
    let session = match session {
        Some(s) => Some(view(&st, s).await),
        None => None,
    };
    Ok(Json(json!({ "session": session })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartBody {
    building: String,
    room_no: i32,
    seat_no: i32,
    period: Option<String>,
}

pub(crate) async fn seat_start(State(st): State<Shared>, user: CurrentUser, Json(b): Json<StartBody>) -> ApiResult<Value> {
    let user_id = user.session.user_id;
    if db::active_seat_session(&st.db, user_id).await?.is_some() {
        return Err(ApiError::conflict("이미 사용 중인 좌석이 있어요."));
    }
    ensure_snapshot(&st).await?;
    let (room_name, _) = seat_info(&st, &b.building, b.room_no, b.seat_no)
        .await
        .ok_or_else(|| ApiError::not_found("선택한 좌석을 찾지 못했어요."))?;
    let period = normalize_period(b.period.as_deref());
    let now = Utc::now();
    let (started_at, source) = match db::seat_state(&st.db, &b.building, b.room_no, b.seat_no).await? {
        Some(s) if s.state == "used" && s.since_known && now - s.since <= Span::minutes(30) => (s.since, "detected"),
        _ => (now, "manual"),
    };
    let session = db::insert_seat_session(
        &st.db,
        user_id,
        NewSeatSession {
            building: &b.building,
            room_no: b.room_no,
            room_name: &room_name,
            seat_no: b.seat_no,
            period,
            started_at,
            start_source: source,
            hours: validity_hours(period) as i32,
        },
    )
    .await?;
    Ok(Json(json!({ "session": view(&st, session).await })))
}

pub(crate) async fn seat_extend(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let user_id = user.session.user_id;
    let mut tx = st.db.begin().await?;
    let current = db::lock_seat_session(&mut tx, user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("사용 중인 좌석이 없어요."))?;
    if current.extend_count > 0 {
        return Err(ApiError::conflict("이미 한 번 연장했어요."));
    }
    let session = db::extend_seat_session(&mut tx, user_id, validity_hours(&current.period) as i32)
        .await?
        .ok_or_else(|| ApiError::conflict("이미 한 번 연장했어요."))?;
    tx.commit().await?;
    Ok(Json(json!({ "session": view(&st, session).await })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdjustBody {
    started_at: i64,
    period: Option<String>,
}

pub(crate) async fn seat_adjust(State(st): State<Shared>, user: CurrentUser, Json(b): Json<AdjustBody>) -> ApiResult<Value> {
    let kst = FixedOffset::east_opt(9 * 3600).expect("KST");
    let selected = Utc.timestamp_opt(b.started_at, 0).single()
        .ok_or_else(|| ApiError::bad_request("입실 시각을 확인해 주세요."))?;
    let today = Utc::now().with_timezone(&kst).date_naive();
    let started_at = today.and_time(selected.with_timezone(&kst).time())
        .and_local_timezone(kst).single()
        .ok_or_else(|| ApiError::bad_request("입실 시각을 확인해 주세요."))?
        .with_timezone(&Utc);
    let period = normalize_period(b.period.as_deref());
    let user_id = user.session.user_id;
    let mut tx = st.db.begin().await?;
    let current = db::lock_seat_session(&mut tx, user_id)
        .await?
        .ok_or_else(|| ApiError::not_found("사용 중인 좌석이 없어요."))?;
    let expires_at = if current.extend_count > 0 {
        current.expires_at + Span::hours(validity_hours(period) - validity_hours(&current.period))
    } else {
        started_at + Span::hours(validity_hours(period))
    };
    let session = db::adjust_seat_session(&mut tx, user_id, started_at, expires_at, period)
        .await?
        .ok_or_else(|| ApiError::not_found("사용 중인 좌석이 없어요."))?;
    tx.commit().await?;
    Ok(Json(json!({ "session": view(&st, session).await })))
}

pub(crate) async fn seat_end(State(st): State<Shared>, user: CurrentUser) -> ApiResult<Value> {
    let ended = db::end_seat_session(&st.db, user.session.user_id, "manual")
        .await?
        .ok_or_else(|| ApiError::not_found("사용 중인 좌석이 없어요."))?;
    Ok(Json(json!({ "session": null, "ended": ended })))
}
