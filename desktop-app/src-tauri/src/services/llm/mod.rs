//! LLM 网关：功能层调用 AI 的唯一入口。
//!
//! 设计见 `docs/features/00-设置页与Key管理/DESIGN.md`。要点：
//! - 功能只声明 `taskId` 调 `analyze()`，不碰 key / HTTP / 厂商名。
//! - 指派解析（resolve）→ 选连接格式适配器 → 退避 → 错误归一。
//! - 软失败 `Auth` / `QuotaExhausted` 由功能侧"外链兜底"。

pub mod adapters;
pub mod commands;
pub mod config;
pub mod resolve;
pub mod tasks;

use std::path::Path;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use config::{KeyStatus, LlmConfig, LlmMode};

/// 网关共享状态（HTTP 客户端复用）。注册到 Tauri `manage`。
pub struct LlmState {
    pub client: reqwest::Client,
}

impl Default for LlmState {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .user_agent("CrossKit/0.2")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }
}

/// 一张图片输入（已编码为 base64）。
#[derive(Debug, Clone)]
pub struct ImageInput {
    pub mime: String,
    pub base64: String,
}

/// 一段音频输入（已编码为 base64）。仅支持音频输入的厂商（如 Gemini）会用，其余适配器忽略。
#[derive(Debug, Clone)]
pub struct AudioInput {
    pub mime: String,
    pub base64: String,
}

/// 统一分析请求。
#[derive(Debug, Clone, Default)]
pub struct AnalyzeRequest {
    pub system: String,
    pub user_text: String,
    pub images: Vec<ImageInput>,
    /// 音频输入（口播转写等）。OpenAI chat 不支持，会被适配器忽略。
    pub audios: Vec<AudioInput>,
    /// 需要结构化返回时传 JSON schema；适配器转成各厂商 JSON mode。
    pub json_schema: Option<Value>,
    /// 预留：token 预算（见设计 §16），MVP 不强制。
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct AnalyzeResponse {
    pub text: String,
    pub json: Option<Value>,
    /// 预留：token 用量统计（设计 §16），当前适配器已填充、暂无读取方。
    #[allow(dead_code)]
    pub usage: Option<Usage>,
}

/// 调用方需要关心的错误。前两种触发"外链兜底"。
#[derive(Debug, Clone)]
pub enum LlmError {
    /// 无可用连接 / key，或处于"仅外链"模式 → 让功能走外链。
    Auth,
    /// 免费额度耗尽（429 持续）。
    QuotaExhausted { reset_at: Option<String> },
    /// 短时限流（已退避仍失败）。预留：适配器后续可区分"瞬时 429"与"额度耗尽"。
    #[allow(dead_code)]
    RateLimited,
    Network(String),
    BadResponse(String),
    /// 该 taskId 没有任何可解析的指派（连全局默认都没设）。
    NotConfigured,
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Auth => write!(f, "没有可用的 AI 连接（请在设置中添加，或改用外链）"),
            LlmError::QuotaExhausted { reset_at } => {
                write!(f, "今日免费额度可能已用尽")?;
                if let Some(r) = reset_at {
                    write!(f, "（预计 {r} 重置）")?;
                }
                Ok(())
            }
            LlmError::RateLimited => write!(f, "请求被限流，请稍后重试"),
            LlmError::Network(e) => write!(f, "网络错误：{e}"),
            LlmError::BadResponse(e) => write!(f, "模型返回异常：{e}"),
            LlmError::NotConfigured => write!(f, "该任务尚未指派模型（请在设置中设默认模型）"),
        }
    }
}

/// 把本地图片文件读成 `ImageInput`（base64）。功能层可用此助手准备帧。
pub fn encode_image_file(path: &str) -> Result<ImageInput, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取图片失败 {path}：{e}"))?;
    let mime = guess_mime(path);
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageInput { mime, base64 })
}

/// 把本地音频文件读成 `AudioInput`（base64）。
pub fn encode_audio_file(path: &str) -> Result<AudioInput, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取音频失败 {path}：{e}"))?;
    let mime = guess_audio_mime(path);
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AudioInput { mime, base64 })
}

fn guess_audio_mime(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    }
    .to_string()
}

fn guess_mime(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
    .to_string()
}

/// 功能层唯一入口：给 taskId + 统一请求，网关负责其余一切。
pub async fn analyze(
    app: &AppHandle,
    client: &reqwest::Client,
    task_id: &str,
    req: AnalyzeRequest,
) -> Result<AnalyzeResponse, LlmError> {
    let cfg = config::load(app);

    // 1) 解析指派
    let model_ref = resolve::resolve_ref(&cfg, task_id).ok_or(LlmError::NotConfigured)?;
    let conn = cfg
        .connection(&model_ref.conn_id)
        .cloned()
        .ok_or(LlmError::NotConfigured)?;

    // 2) 模式 + 连接可用性裁决
    if cfg.mode == LlmMode::Weblink {
        return Err(LlmError::Auth);
    }
    if !conn.enabled || conn.usable_key().is_none() {
        // auto / api 都无法走 API → 让功能外链兜底
        return Err(LlmError::Auth);
    }

    // 3) 选适配器调用 + 简单退避
    let adapter = adapters::adapter_for(conn.format);
    let mut attempt = 0u32;
    loop {
        match adapter.call(client, &conn, &model_ref.model, &req).await {
            Ok(resp) => return Ok(resp),
            Err(LlmError::RateLimited) if attempt < 2 => {
                attempt += 1;
                let backoff = std::time::Duration::from_millis(800 * attempt as u64);
                tokio::time::sleep(backoff).await;
                continue;
            }
            Err(LlmError::QuotaExhausted { reset_at }) => {
                mark_key_quota_exhausted(app, &conn.id, reset_at.clone());
                return Err(LlmError::QuotaExhausted { reset_at });
            }
            Err(e) => return Err(e),
        }
    }
}

/// 命中额度耗尽时，把该连接首个可用 key 标记为 quota_exhausted 并持久化。
fn mark_key_quota_exhausted(app: &AppHandle, conn_id: &str, reset_at: Option<String>) {
    let mut cfg: LlmConfig = config::load(app);
    if let Some(conn) = cfg.connection_mut(conn_id) {
        if let Some(k) = conn
            .keys
            .iter_mut()
            .find(|k| k.status != KeyStatus::QuotaExhausted)
        {
            k.status = KeyStatus::QuotaExhausted;
            k.quota_reset_at = reset_at;
        }
    }
    let _ = config::save(app, &cfg);
}
