use std::sync::Arc;

use chrono::Utc;
use hongsi_core::calendar::{self};
use hongsi_core::models::{Assignment, SubmissionInfo};
use hongsi_core::submission;
use serde_json::{json, Value};
use submission::{Job, Progress, Stage, Status, JOB_TIMEOUT};

use crate::rejection;
use crate::{Direct, Reply, School, MB, R};

impl Direct {
    pub(super) async fn notifications(&self)->R<Value>{self.shared_school("notices",false).await}

    pub(super) async fn find_assignment(&self, s: &School, cmid: i64) -> R<Assignment> {
        Ok(s.session.assignment(cmid).await?)
    }

    pub(super) fn view(a: &Assignment, info: &SubmissionInfo) -> Value {
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

    pub(super) async fn submission_view(&self, cmid: i64) -> R<Value> {
        let s = self.current().await?;
        let a = self.find_assignment(&s, cmid).await?;
        let info = s.session.submission_info(a.id).await?;
        Ok(Self::view(&a, &info))
    }

    pub async fn begin_submission(&self, cmid: i64, id: &str) -> Result<(Arc<Job>, bool), Reply> {
        let school = self.current().await?;
        self.submissions
            .start(&school.student_id, cmid, id)
            .map_err(|message| Reply::error(409, "conflict", message))
    }

    pub async fn submit_job(
        &self,
        cmid: i64,
        keep: Vec<String>,
        files: Vec<(String, Vec<u8>)>,
        late: bool,
        statement: bool,
        job: Arc<Job>,
    ) -> Reply {
        match tokio::time::timeout(JOB_TIMEOUT, self.submit_inner(cmid, keep, files, late, statement, job.clone())).await {
            Ok(Ok(result)) => job.complete(result),
            Ok(Err(reply)) => job.fail(
                reply.status,
                reply.code().unwrap_or("school_error"),
                reply.body["error"]["message"].as_str().unwrap_or("제출 결과를 확인하지 못했어요."),
            ),
            Err(_) => job.fail(504, "timeout", "학교의 응답이 늦어지고 있어요."),
        }
        Reply::ok(json!(job.snapshot()))
    }

    pub async fn submission_status(&self, cmid: i64, id: &str, verify: bool) -> Reply {
        let result = async {
            let school = self.current().await?;
            let job = self.submissions.get(&school.student_id, cmid, id).ok_or_else(|| {
                Reply::error(
                    404,
                    "not_found",
                    "클래스룸에서 제출 상태를 확인해 주세요.",
                )
            })?;
            if verify && job.snapshot().status == Status::Uncertain {
                let assignment = self.find_assignment(&school, cmid).await?;
                let info = school.session.submission_info(assignment.id).await?;
                if job.matches(&info) {
                    school.session.invalidate_calendar_course(assignment.course_id);
                    school.calendar.lock().await.invalidate_assignment(&format!("assign:{cmid}"));
                    let key = format!("assign:{cmid}");
                    let _ = self.set_done(&key, &json!({ "done": true })).await;
                    self.patch_items(&school, &key, |item| {
                        item.status = "submitted";
                        item.done = true;
                    })
                    .await;
                    let _ = self.shared_school("calendar",true).await;
                    job.complete(Self::view(&assignment, &info));
                }
            }
            Ok(json!(job.snapshot()))
        }
        .await;
        match result {
            Ok(value) => Reply::ok(value),
            Err(reply) => reply,
        }
    }

    pub(super) async fn submit_inner(
        &self,
        cmid: i64,
        keep: Vec<String>,
        files: Vec<(String, Vec<u8>)>,
        late_confirmed: bool,
        accept_statement: bool,
        job: Arc<Job>,
    ) -> R<Value> {
        let s = self.current().await?;
        let a = self.find_assignment(&s, cmid).await?;
        let info = s.session.submission_info(a.id).await?;
        let sizes: Vec<(String, usize)> = files.iter().map(|(n, b)| (n.clone(), b.len())).collect();
        calendar::check_submission(&a, &info, Utc::now().timestamp(), &keep, &sizes, late_confirmed, accept_statement)
            .map_err(rejection)?;
        let mut all = Vec::with_capacity(keep.len() + files.len());
        for name in &keep {
            let existing = info
                .files
                .iter()
                .find(|f| &f.name == name)
                .ok_or_else(|| Reply::error(400, "bad_request", "기존 파일을 찾지 못했어요."))?;
            let (_, bytes) = s.session.download(&existing.url, 1024 * MB).await?;
            all.push((existing.name.clone(), bytes));
        }
        all.extend(files);
        job.expect(&info, &all);
        s.session
            .submit_files_with_progress(a.id, all, a.config.drafts, accept_statement, job.clone())
            .await?;
        job.acknowledge();
        job.progress(Progress::at(Stage::Verify));
        let info = s.session.submission_info(a.id).await?;
        if !job.matches(&info) {
            return Err(Reply::error(
                502,
                "submission_unconfirmed",
                "제출 상태와 파일 목록이 아직 확인되지 않았어요.",
            ));
        }
        tracing::info!(cmid, "과제 제출 완료 (기기)");
        s.session.invalidate_calendar_course(a.course_id);
        s.calendar.lock().await.invalidate_assignment(&format!("assign:{cmid}"));
        let key = format!("assign:{cmid}");
        let _ = self.set_done(&key, &json!({ "done": true })).await;
        self.patch_items(&s, &key, |item| {
            item.status = "submitted";
            item.done = true;
        })
        .await;
        let _ = self.shared_school("calendar",true).await;
        Ok(Self::view(&a, &info))
    }
}
