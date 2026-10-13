use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("학교 서버에 연결하지 못했어요.")]
    Network(#[from] reqwest::Error),
    #[error("{0}")]
    LoginRejected(String),
    #[error("학교 로그인 세션이 만료됐어요.")]
    SessionExpired,
    #[error("클래스룸 로그인 토큰이 만료됐어요.")]
    ClassroomTokenExpired,
    #[error("학교 페이지의 정보를 읽지 못했어요 ({0})")]
    Parse(String),
    #[error("{0}")]
    Upstream(String),
    #[error("{0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

pub fn login_rejection_message(message: &str) -> &'static str {
    let compact: String = message.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    if compact.contains("잠겼") || compact.contains("잠금") || compact.contains("잠긴") {
        "계정이 잠겼어요."
    } else if compact.contains("비밀번호") && (compact.contains("만료") || compact.contains("변경해야")) {
        "학교에서 비밀번호를 변경해 주세요."
    } else if (compact.contains("비밀번호") || compact.contains("id") || compact.contains("학번"))
        && ["잘못", "불일치", "일치하지", "등록되지", "확인해", "확인후", "틀렸"].iter().any(|word| compact.contains(word)) {
        "학번 또는 비밀번호를 확인해 주세요."
    } else {
        "로그인하지 못했어요."
    }
}
