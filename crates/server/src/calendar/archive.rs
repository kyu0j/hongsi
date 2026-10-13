use std::collections::{HashMap, HashSet};

use chrono::Utc;
use hongsi_core::calendar_cache::SchoolCalendarData;
use hongsi_core::models::SemesterDisplay;
use sqlx::{Executor, FromRow, PgPool, Postgres, types::Json};

use super::{CalendarData, SnapshotInfo};

#[derive(FromRow)]
pub struct Record {
    pub school_data: Json<SchoolCalendarData>,
    pub updated_at: i64,
    pub current_updated_at: i64,
    pub initialized: bool,
}

pub async fn load<'a>(db: impl Executor<'a, Database = Postgres>, uid: i64) -> sqlx::Result<Option<Record>> {
    sqlx::query_as("select school_data,updated_at,current_updated_at,initialized from calendar_archives where user_id=$1")
        .bind(uid).fetch_optional(db).await
}

pub(crate) fn merge(all: &mut SchoolCalendarData, current: &SchoolCalendarData) {
    let mut current = current.clone();
    current.preserve_failed(all);
    let ids: HashSet<_> = current.courses.iter().map(|c| c.id).chain(all.courses.iter()
        .filter(|c| current.current_term.is_some() && c.term == current.current_term).map(|c| c.id)).collect();
    all.courses.retain(|c| !ids.contains(&c.id));
    all.courses.extend(current.courses.iter().cloned());
    all.courses.sort_by(|a, b| b.term.map(|t| (t.year, t.semester)).cmp(&a.term.map(|t| (t.year, t.semester)))
        .then(a.code.cmp(&b.code)).then(a.name.cmp(&b.name)));
    all.assignments.retain(|a| !ids.contains(&a.course_id));
    all.assignments.extend(current.assignments.iter().cloned());
    all.vods.retain(|v| !ids.contains(&v.course_id));
    all.vods.extend(current.vods.iter().cloned());
    all.failed_course_ids.retain(|id| !ids.contains(id));
    all.failed_course_ids.extend(current.failed_course_ids.iter().copied());
    all.current_term = current.current_term;
}

pub async fn render(db: &PgPool, uid: i64, record: Record) -> sqlx::Result<CalendarData> {
    type Row = (i64, chrono::DateTime<Utc>, Option<chrono::DateTime<Utc>>, String, i32);
    let rows: Vec<Row> = sqlx::query_as("select cmid,first_seen_at,first_due_at,first_intro_html,change_count from assignment_snapshots where user_id=$1")
        .bind(uid).fetch_all(db).await?;
    let snapshots: HashMap<_, _> = rows.into_iter().map(|(cmid, seen, due, html, changes)| (cmid, SnapshotInfo {
        first_seen: seen.timestamp(), first_due: due.map(|v| v.timestamp()), first_intro_html: html, change_count: changes,
    })).collect();
    let state = super::load_state(db, uid).await?;
    let SchoolCalendarData { current_term, courses, assignments, vods, failed_course_ids } = record.school_data.0;
    Ok(CalendarData {
        semester_display: SemesterDisplay::All, current_term, courses,
        items: super::build(&assignments, &vods, &snapshots, &state.checks, &state.alerts_off, &state.alert_leads, Utc::now().timestamp()),
        fetched_at: record.current_updated_at.max(record.updated_at) / 1000,
        archive_updated_at: Some(record.updated_at),
        failed_course_ids,
    })
}

