use crate::{Direct, Reply, R};
use hongsi_core::models::SemesterDisplay;
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;

impl Direct {
    pub(super) async fn shared_school(&self, kind: &str, refresh: bool) -> R<Value> {
        self.shared_school_for(kind, refresh, false).await
    }
    pub(super) async fn shared_school_for(
        &self,
        kind: &str,
        refresh: bool,
        current_only: bool,
    ) -> R<Value> {
        let generation = self.generation();
        let path = format!("/api/school/{kind}");
        let claim = self
            .server(
                &Method::POST,
                &path,
                Some(&json!({"refresh":refresh,"currentOnly":current_only})),
            )
            .await;
        if claim.status != 200 {
            return Err(claim);
        }
        let Some(token) = claim.body["token"].as_str() else {
            return Ok(claim.body["data"].clone());
        };
        let fetch = async {
            let school = self.current().await?;
            let data = match kind {
                "calendar" => {
                    let data =
                        if claim.body["catalog"].is_object() {
                            let term = serde_json::from_value(
                                claim.body["catalog"]["currentTerm"].clone(),
                            )
                            .map_err(|_| {
                                Reply::error(502, "invalid_response", "학교 정보를 확인해 주세요.")
                            })?;
                            let courses =
                                serde_json::from_value(claim.body["catalog"]["courses"].clone())
                                    .map_err(|_| {
                                        Reply::error(
                                            502,
                                            "invalid_response",
                                            "학교 정보를 확인해 주세요.",
                                        )
                                    })?;
                            school
                                .session
                                .calendar_for_courses(term, courses, true)
                                .await?
                        } else {
                            school
                                .session
                                .calendar_school(SemesterDisplay::Current, false)
                                .await?
                        };
                    json!(data)
                }
                "archive" => json!(
                    school
                        .session
                        .calendar_school(SemesterDisplay::All, refresh)
                        .await?
                ),
                "timetable" => json!(school.session.timetable().await?),
                "notices" => json!(school.session.recent_notifications().await?),
                _ => return Err(Reply::error(400, "bad_request", "잘못된 요청이에요.")),
            };
            Ok(data)
        };
        let result = tokio::time::timeout(Duration::from_secs(100), fetch)
            .await
            .unwrap_or_else(|_| {
                Err(Reply::error(
                    504,
                    "timeout",
                    "학교의 응답이 늦어지고 있어요.",
                ))
            });
        if generation != self.generation() {
            return Err(Reply::error(
                409,
                "account_changed",
                "로그인 상태가 변경됐어요.",
            ));
        }
        match result {
            Ok(data) => {
                let saved = self
                    .server(
                        &Method::PUT,
                        &path,
                        Some(&json!({"token":token,"data":data,"currentOnly":current_only})),
                    )
                    .await;
                if saved.status != 200 {
                    return Err(saved);
                }
                Ok(saved.body)
            }
            Err(error) => {
                let _=self.server(&Method::PUT,&path,Some(&json!({"token":token,"error":error.code().unwrap_or("school_unreachable")}))).await;
                Err(error)
            }
        }
    }
}
