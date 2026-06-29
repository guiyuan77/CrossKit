//! 格式适配器：厂商差异的唯一容身处。
//! 新增厂商 = 在此加一个 `ChatAdapter` 实现 + `LlmFormat` 加一项 + `adapter_for` 加分支。

pub mod gemini;
pub mod openai;

use async_trait::async_trait;

use super::config::{Connection, LlmFormat};
use super::{AnalyzeRequest, AnalyzeResponse, LlmError};

/// 把统一请求映射到具体厂商格式，并把响应解析回统一结构。
#[async_trait]
pub trait ChatAdapter: Send + Sync {
    /// 一次结构化/文本分析调用。
    async fn call(
        &self,
        client: &reqwest::Client,
        conn: &Connection,
        model: &str,
        req: &AnalyzeRequest,
    ) -> Result<AnalyzeResponse, LlmError>;

    /// 列出可用模型；同时用于"测试连接"（能成功=key 有效）。
    async fn list_models(
        &self,
        client: &reqwest::Client,
        conn: &Connection,
    ) -> Result<Vec<String>, LlmError>;
}

/// 按连接格式取适配器（静态分发到具体实现）。
pub fn adapter_for(format: LlmFormat) -> &'static dyn ChatAdapter {
    match format {
        LlmFormat::Openai => &openai::OpenAiAdapter,
        LlmFormat::Gemini => &gemini::GeminiAdapter,
    }
}

/// 把 HTTP 状态码归一为网关错误（401/403→Auth，429→限流/额度）。
pub(crate) fn map_status(status: reqwest::StatusCode, body: &str) -> LlmError {
    match status.as_u16() {
        401 | 403 => LlmError::Auth,
        429 => {
            // 免费档每日额度耗尽与短时限流都可能是 429；统一先按额度耗尽处理（更安全，触发外链）。
            LlmError::QuotaExhausted { reset_at: None }
        }
        _ => LlmError::BadResponse(format!("HTTP {status}: {}", truncate(body, 300))),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}

/// 从模型文本里尽力抽出 JSON（兼容 ```json 包裹 / 前后有解释文字的情况）。
pub(crate) fn extract_json(text: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        return Some(v);
    }
    // 去掉 ``` 包裹
    let cleaned = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(cleaned) {
        return Some(v);
    }
    // 退而求其次：截取第一个 { 到最后一个 }
    let (start, end) = (text.find('{'), text.rfind('}'));
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[s..=e]) {
                return Some(v);
            }
        }
    }
    None
}
