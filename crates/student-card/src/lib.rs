mod protocol;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

use protocol::Session;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub platform: String,
    pub device_id: String,
    pub user_agent: String,
    pub locale_version: String,
    pub active: bool,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CardResult {
    Ready(Ready),
    #[serde(untagged)]
    Failed(Failure),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    image_data_url: String,
    valid_for_ms: u64,
    processing_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    state: &'static str,
    message: &'static str,
    retryable: bool,
}

impl Failure {
    pub fn unavailable() -> Self {
        Self::message("학생증 QR을 불러오지 못했어요.")
    }
    pub fn cancelled() -> Self {
        Self::message("학생증 QR 창을 다시 열어 주세요.")
    }
    pub fn credentials() -> Self {
        Self {
            state: "credentials_required",
            message: "자동 로그인을 켜고 로그인해 주세요.",
            retryable: false,
        }
    }
    pub fn authentication(message: &'static str) -> Self {
        Self {
            state: "authentication_required",
            message,
            retryable: false,
        }
    }
    fn message(message: &'static str) -> Self {
        Self {
            state: "unavailable",
            message,
            retryable: true,
        }
    }
    fn response_size() -> Self {
        Self::message("학생증 응답을 처리하지 못했어요.")
    }
}

pub struct Ticket {
    view: String,
    request: u64,
    started: Instant,
    cancel: CancellationToken,
    fresh: bool,
}

impl Ticket {
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await;
    }
}

struct View {
    id: String,
    request: u64,
    cancel: CancellationToken,
    busy: bool,
}

#[derive(Default)]
struct State {
    view: Option<View>,
    cache: Option<(Session, Instant)>,
    closed: VecDeque<String>,
}

impl State {
    fn close(&mut self, id: &str) {
        if !self.closed.iter().any(|value| value == id) {
            self.closed.push_back(id.to_owned());
            if self.closed.len() > 128 {
                self.closed.pop_front();
            }
        }
        if self.view.as_ref().is_some_and(|view| view.id == id) {
            if let Some(view) = self.view.take() {
                view.cancel.cancel();
                if view.busy {
                    self.cache = None;
                }
            }
        }
    }
    fn active(&self, ticket: &Ticket) -> bool {
        !ticket.cancel.is_cancelled()
            && self
                .view
                .as_ref()
                .is_some_and(|view| view.id == ticket.view && view.request == ticket.request)
    }
}

#[derive(Default)]
pub struct StudentCards {
    state: Mutex<State>,
    sequence: AtomicU64,
}

impl StudentCards {
    pub fn begin(&self, view: &str, fresh: bool) -> Result<Ticket, Failure> {
        if view.len() != 36
            || !view.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Err(Failure::cancelled());
        }
        let mut state = self.state.lock().unwrap();
        if state.closed.iter().any(|id| id == view) {
            return Err(Failure::cancelled());
        }
        if fresh {
            if let Some(previous) = state.view.as_ref().map(|view| view.id.clone()) {
                if previous == view {
                    return Err(Failure::cancelled());
                }
                state.close(&previous);
            }
        } else if !state
            .view
            .as_ref()
            .is_some_and(|current| current.id == view && !current.busy)
        {
            return Err(Failure::authentication(
                "학생증을 다시 불러와 주세요.",
            ));
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = CancellationToken::new();
        state.view = Some(View {
            id: view.into(),
            request: id,
            cancel: cancel.clone(),
            busy: true,
        });
        Ok(Ticket {
            view: view.into(),
            request: id,
            started: Instant::now(),
            cancel,
            fresh,
        })
    }

    pub fn close(&self, view: &str) {
        self.state.lock().unwrap().close(view);
    }

    pub fn suspend(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(view) = state.view.as_ref().map(|view| view.id.clone()) {
            state.close(&view);
        }
    }

    pub fn reset(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(view) = state.view.as_ref().map(|view| view.id.clone()) {
            state.close(&view);
        }
        state.cache = None;
    }

    pub fn failed(&self, ticket: &Ticket) {
        let mut state = self.state.lock().unwrap();
        if state.active(ticket) {
            state.cache = None;
            state.close(&ticket.view);
        }
    }

    pub async fn issue(
        &self,
        ticket: &Ticket,
        owner: &str,
        password: &str,
        context: &Context,
    ) -> Result<(Ready, String), Failure> {
        if !context.active
            || context.device_id.is_empty()
            || context.device_id.len() > 128
            || context.user_agent.len() > 1024
        {
            return Err(Failure::cancelled());
        }
        let cached = {
            let mut state = self.state.lock().unwrap();
            if !state.active(ticket) {
                return Err(Failure::cancelled());
            }
            state.cache.take().filter(|(session, used)| {
                session.owner == owner
                    && session.platform == context.platform
                    && used.elapsed() < Duration::from_secs(300)
            })
        };
        let mut session = match cached {
            Some((session, _)) => session,
            None if !ticket.fresh => {
                return Err(Failure::authentication(
                    "학생증을 다시 불러와 주세요.",
                ))
            }
            None => {
                let mut session = Session::new(owner, context)?;
                session.login(password, context).await?;
                session
            }
        };
        let ready = session.qr(ticket.started).await?;
        let locale_version = std::mem::take(&mut session.locale_version);
        let mut state = self.state.lock().unwrap();
        if !state.active(ticket) {
            return Err(Failure::cancelled());
        }
        if let Some(view) = &mut state.view {
            view.busy = false;
        }
        state.cache = Some((session, Instant::now()));
        Ok((ready, locale_version))
    }
}
