use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{stream, StreamExt};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::calendar::CalendarData;
use crate::models::{AcademicTerm, Assignment, Course, SemesterDisplay, Vod};
use crate::{Result, SchoolSession};

pub const CURRENT_MAX_AGE: Duration = Duration::from_secs(5 * 60);
pub const PAST_MAX_AGE: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchoolCalendarData {
    pub current_term: Option<AcademicTerm>,
    pub courses: Vec<Course>,
    pub assignments: Vec<Assignment>,
    pub vods: Vec<Vod>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_course_ids: Vec<i64>,
}

impl SchoolCalendarData {
    pub fn retain_current(&mut self) {
        self.courses.retain(|course| course.term == self.current_term);
        let ids: std::collections::HashSet<_> = self.courses.iter().map(|course|course.id).collect();
        self.assignments.retain(|item|ids.contains(&item.course_id));
        self.vods.retain(|item|ids.contains(&item.course_id));
        self.failed_course_ids.retain(|id|ids.contains(id));
    }

    pub fn preserve_failed(&mut self, previous: &Self) {
        for id in &self.failed_course_ids {
            if !previous.assignments.iter().any(|item| item.course_id == *id)
                && !previous.vods.iter().any(|item| item.course_id == *id)
            {
                continue;
            }
            self.assignments.retain(|item| item.course_id != *id);
            self.assignments.extend(previous.assignments.iter().filter(|item| item.course_id == *id).cloned());
            self.vods.retain(|item| item.course_id != *id);
            self.vods.extend(previous.vods.iter().filter(|item| item.course_id == *id).cloned());
        }
    }
}

#[derive(Clone)]
struct CourseData {
    at: Instant,
    assignments: Vec<Assignment>,
    vods: Vec<Vod>,
}

#[derive(Default)]
struct CourseSlot {
    data: Mutex<Option<CourseData>>,
    loading: AsyncMutex<()>,
    revision: AtomicU64,
}

pub(crate) struct SchoolCalendarCache {
    catalog: AsyncMutex<Option<(Instant, Option<AcademicTerm>, Vec<Course>)>>,
    courses: Mutex<HashMap<i64, Arc<CourseSlot>>>,
    budget: Semaphore,
}

impl Default for SchoolCalendarCache {
    fn default() -> Self {
        Self {
            catalog: AsyncMutex::new(None),
            courses: Mutex::new(HashMap::new()),
            budget: Semaphore::new(4),
        }
    }
}

impl SchoolSession {
    pub async fn calendar_school(
        &self,
        display: SemesterDisplay,
        refresh: bool,
    ) -> Result<SchoolCalendarData> {
        let (current_term, mut courses) = {
            let mut catalog = self.calendar_school_cache.catalog.lock().await;
            if refresh
                || catalog.as_ref().is_none_or(|(at, term, _)| {
                    at.elapsed() >= CURRENT_MAX_AGE
                        || (display == SemesterDisplay::Current && term.is_none())
                })
            {
                let (term, courses) = self.courses_for(SemesterDisplay::All).await?;
                *catalog = Some((Instant::now(), term, courses));
            }
            let (_, term, courses) = catalog.as_ref().expect("과목 목록");
            (*term, courses.clone())
        };
        if display == SemesterDisplay::Current {
            let term =
                current_term.ok_or_else(|| crate::CoreError::Parse("클래스룸 기본 학기".into()))?;
            courses.retain(|course| course.term == Some(term));
        }
        self.calendar_for_courses(current_term, courses, refresh).await
    }

    pub async fn calendar_for_courses(&self, current_term: Option<AcademicTerm>, courses: Vec<Course>, refresh: bool) -> Result<SchoolCalendarData> {
        let mut results: Vec<_> = stream::iter(courses.clone().into_iter().enumerate())
            .map(|(index, course)| async move {
                (index, self.calendar_course(&course, current_term, refresh).await)
            })
            .buffer_unordered(4)
            .collect()
            .await;
        results.sort_by_key(|(index, _)| *index);
        let mut assignments = Vec::new();
        let mut vods = Vec::new();
        let mut failed_course_ids = Vec::new();
        let mut first_error = None;
        let mut available = 0;
        for (index, result) in results {
            let course = &courses[index];
            let result = match result {
                Err(error) if matches!(error, crate::CoreError::SessionExpired | crate::CoreError::ClassroomTokenExpired | crate::CoreError::LoginRejected(_)) => return Err(error),
                Err(error) => match tokio::time::timeout(
                    Duration::from_secs(3),
                    self.calendar_course(course, current_term, true),
                ).await {
                    Ok(retry) => retry,
                    Err(_) => Err(error),
                },
                result => result,
            };
            let data = match result {
                Ok(data) => Some(data),
                Err(error) => {
                    if matches!(error, crate::CoreError::SessionExpired | crate::CoreError::ClassroomTokenExpired | crate::CoreError::LoginRejected(_)) {
                        return Err(error);
                    }
                    failed_course_ids.push(course.id);
                    if first_error.is_none() { first_error = Some(error); }
                    self.calendar_school_cache.courses.lock().expect("과목 캐시 잠금")
                        .get(&course.id).and_then(|slot| slot.data.lock().expect("과목 캐시 잠금").clone())
                }
            };
            if let Some(data) = data {
                available += 1;
                assignments.extend(data.assignments);
                vods.extend(data.vods);
            }
        }
        if available == 0 {
            if let Some(error) = first_error { return Err(error); }
        }
        Ok(SchoolCalendarData { current_term, courses, assignments, vods, failed_course_ids })
    }

    async fn calendar_course(
        &self,
        course: &Course,
        current: Option<AcademicTerm>,
        refresh: bool,
    ) -> Result<CourseData> {
        let slot = {
            let mut entries = self
                .calendar_school_cache
                .courses
                .lock()
                .expect("과목 캐시 잠금");
            entries.entry(course.id).or_default().clone()
        };
        let max_age = if current.is_some() && course.term != current {
            PAST_MAX_AGE
        } else {
            CURRENT_MAX_AGE
        };
        let cached = || {
            slot.data
                .lock()
                .expect("과목 캐시 잠금")
                .as_ref()
                .filter(|data| data.at.elapsed() < max_age)
                .cloned()
        };
        if !refresh {
            if let Some(data) = cached() {
                return Ok(data);
            }
        }
        let started = Instant::now();
        let _loading = slot.loading.lock().await;
        if let Some(data) = cached().filter(|data| !refresh || data.at >= started) {
            return Ok(data);
        }
        let _permit = self
            .calendar_school_cache
            .budget
            .acquire()
            .await
            .expect("학교 조회 제한");
        loop {
            let revision = slot.revision.load(Ordering::Acquire);
            let (assignments, vods) = tokio::try_join!(
                self.assignments(std::slice::from_ref(course)),
                self.vods(std::slice::from_ref(course))
            )?;
            let data = CourseData {
                at: Instant::now(),
                assignments,
                vods,
            };
            let mut stored = slot.data.lock().expect("과목 캐시 잠금");
            if slot.revision.load(Ordering::Acquire) != revision {
                continue;
            }
            *stored = Some(data.clone());
            return Ok(data);
        }
    }

    pub fn invalidate_calendar_course(&self, course_id: i64) {
        let slot = self
            .calendar_school_cache
            .courses
            .lock()
            .expect("과목 캐시 잠금")
            .get(&course_id)
            .cloned();
        if let Some(slot) = slot {
            let mut data = slot.data.lock().expect("과목 캐시 잠금");
            slot.revision.fetch_add(1, Ordering::AcqRel);
            *data = None;
        }
    }
}

struct CachedCalendar {
    at: Instant,
    valid: bool,
    data: CalendarData,
}

#[derive(Default)]
pub struct CalendarResults {
    entries: Vec<CachedCalendar>,
}

impl CalendarResults {
    pub fn get(&self, display: SemesterDisplay) -> Option<CalendarData> {
        let fresh = |entry: &&CachedCalendar| entry.valid && entry.at.elapsed() < CURRENT_MAX_AGE;
        if let Some(entry) = self
            .entries
            .iter()
            .filter(fresh)
            .find(|entry| entry.data.semester_display == display)
        {
            return Some(entry.data.clone());
        }
        if display == SemesterDisplay::Current {
            let entry = self
                .entries
                .iter()
                .filter(fresh)
                .find(|entry| entry.data.semester_display == SemesterDisplay::All)?;
            return current_calendar(&entry.data);
        }
        None
    }

    pub fn set(&mut self, data: CalendarData) {
        let display = data.semester_display;
        self.entries
            .retain(|entry| entry.data.semester_display != display);
        if display == SemesterDisplay::All {
            if let Some(current) = current_calendar(&data) {
                self.entries
                    .retain(|entry| entry.data.semester_display != SemesterDisplay::Current);
                self.entries.push(CachedCalendar {
                    at: Instant::now(),
                    valid: current.failed_course_ids.is_empty(),
                    data: current,
                });
            }
        } else if let Some(all) = self
            .entries
            .iter_mut()
            .find(|entry| entry.data.semester_display == SemesterDisplay::All)
        {
            let ids: std::collections::HashSet<_> =
                data.courses.iter().map(|course| course.id).collect();
            let previous_ids: std::collections::HashSet<_> = all
                .data
                .courses
                .iter()
                .filter(|course| data.current_term.is_some() && course.term == data.current_term)
                .map(|course| course.id)
                .collect();
            all.data
                .courses
                .retain(|course| !previous_ids.contains(&course.id));
            all.data.courses.extend(data.courses.iter().cloned());
            all.data.courses.sort_by(|a, b| {
                let term = |course: &Course| course.term.map(|term| (term.year, term.semester));
                term(b)
                    .cmp(&term(a))
                    .then(a.code.cmp(&b.code))
                    .then(a.name.cmp(&b.name))
            });
            all.data.items.retain(|item| {
                !previous_ids.contains(&item.course_id) && !ids.contains(&item.course_id)
            });
            all.data.items.extend(data.items.iter().cloned());
            all.data
                .items
                .sort_by_key(|item| item.due.unwrap_or(i64::MAX));
            all.data.current_term = data.current_term;
            all.data.failed_course_ids.retain(|id| !ids.contains(id) && !previous_ids.contains(id));
            all.data.failed_course_ids.extend(data.failed_course_ids.iter().copied());
            all.valid = all.data.failed_course_ids.is_empty();
        }
        self.entries.push(CachedCalendar {
            at: Instant::now(),
            valid: data.failed_course_ids.is_empty(),
            data,
        });
    }

    pub fn values(&self) -> impl Iterator<Item = &CalendarData> {
        self.entries.iter().map(|entry| &entry.data)
    }

    pub fn patch_items(
        &mut self,
        key: &str,
        mut patch: impl FnMut(&mut crate::calendar::CalendarItem),
    ) {
        for entry in &mut self.entries {
            entry
                .data
                .items
                .iter_mut()
                .filter(|item| item.key == key)
                .for_each(&mut patch);
        }
    }

    pub fn invalidate_assignment(&mut self, key: &str) {
        for entry in &mut self.entries {
            if entry.data.items.iter().any(|item| item.key == key) {
                entry.valid = false;
            }
        }
    }
}

fn current_calendar(data: &CalendarData) -> Option<CalendarData> {
    let term = data.current_term?;
    let mut current = data.clone();
    current.semester_display = SemesterDisplay::Current;
    current.courses.retain(|course| course.term == Some(term));
    let ids: std::collections::HashSet<_> =
        current.courses.iter().map(|course| course.id).collect();
    current.items.retain(|item| ids.contains(&item.course_id));
    current.failed_course_ids.retain(|id| ids.contains(id));
    Some(current)
}
