use hongsi_core::calendar;
use hongsi_core::models::SemesterDisplay;
use reqwest::Method;
use serde_json::Value;

use crate::encode;
use crate::{Direct, Reply, School, R};

impl Direct {
    pub(super) async fn calendar(&self, _refresh:bool, display:SemesterDisplay)->R<Value>{
        self.shared_school(if display.enabled()==SemesterDisplay::All{"archive"}else{"calendar"},false).await
    }
    pub(super) async fn calendar_archive(&self,refresh:bool,display:SemesterDisplay)->R<Value>{
        self.shared_school_for("archive",refresh,display==SemesterDisplay::Current).await
    }

    pub(super) async fn patch_items(&self, s: &School, key: &str, f: impl Fn(&mut calendar::CalendarItem)) {
        s.calendar.lock().await.patch_items(key, f);
    }

    pub(super) async fn set_done(&self, key: &str, body: &Value) -> Reply {
        let path = format!("/api/calendar/items/{}/done", encode(key));
        let reply = self.server(&Method::PUT, &path, Some(body)).await;
        if reply.status == 200 {
            if let Ok(s) = self.current().await {
                self.patch_items(&s, key, |item| {
                    item.done_override = body["done"].as_bool();
                    item.done = item.done_override.unwrap_or(item.status == "submitted" || item.status == "done");
                })
                .await;
            }
        }
        reply
    }

    pub(super) async fn set_alert(&self, key: &str, body: &Value) -> Reply {
        let path = format!("/api/calendar/items/{}/alert", encode(key));
        let reply = self.server(&Method::PUT, &path, Some(body)).await;
        if reply.status == 200 {
            if let (Ok(s), Some(on)) = (self.current().await, body["on"].as_bool()) {
                self.patch_items(&s, key, |item| item.alert = on).await;
            }
        }
        reply
    }

    pub(super) async fn set_alert_leads(&self, key: &str, body: &Value) -> Reply {
        let path = format!("/api/calendar/items/{}/alert-leads", encode(key));
        let reply = self.server(&Method::PUT, &path, Some(body)).await;
        if reply.status == 200 {
            if let Ok(s) = self.current().await {
                let leads: Option<Vec<i32>> = serde_json::from_value(reply.body["leads"].clone()).unwrap_or_default();
                self.patch_items(&s, key, |item| item.alert_leads = leads.clone()).await;
            }
        }
        reply
    }
}
