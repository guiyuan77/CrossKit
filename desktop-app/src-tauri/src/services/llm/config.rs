//! LLM 网关的配置模型与持久化（连接 connections + 指派 assignments + 模式 mode）。
//!
//! 存储：写入 `settings.json` 的 `llm` 键（tauri-plugin-store）。
//! 明文 key 只存在 `Connection.keys[].key`，仅后端读取；给前端用 `*_masked` 视图。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::services::secrets::mask;

const STORE_FILE: &str = "settings.json";
const LLM_KEY: &str = "llm";

/// 厂商 API 格式。新增厂商=加一个适配器 + 此枚举加一项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmFormat {
    Openai,
    Gemini,
}

/// 调用裁决模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmMode {
    Auto,
    Api,
    Weblink,
}

impl Default for LlmMode {
    fn default() -> Self {
        LlmMode::Auto
    }
}

/// 单个 key 的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStatus {
    Unknown,
    Valid,
    Invalid,
    QuotaExhausted,
}

impl Default for KeyStatus {
    fn default() -> Self {
        KeyStatus::Unknown
    }
}

/// 含明文 key 的凭据条目（仅后端）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionKey {
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub status: KeyStatus,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    #[serde(default)]
    pub quota_reset_at: Option<String>,
}

/// 一个厂商连接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub label: String,
    pub format: LlmFormat,
    pub base_url: String,
    #[serde(default)]
    pub keys: Vec<ConnectionKey>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 指向"某连接的某模型"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub conn_id: String,
    pub model: String,
}

/// 指派表：全局默认 + 按 scope（moduleId / taskId）覆盖。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignments {
    #[serde(default)]
    pub global: Option<ModelRef>,
    #[serde(default)]
    pub overrides: HashMap<String, ModelRef>,
}

/// 完整 LLM 配置（后端态，含明文）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default)]
    pub mode: LlmMode,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub assignments: Assignments,
}

impl Connection {
    /// 取第一个可用（valid/unknown 且非额度耗尽）的明文 key。
    pub fn usable_key(&self) -> Option<&ConnectionKey> {
        self.keys
            .iter()
            .find(|k| !k.key.trim().is_empty() && k.status != KeyStatus::QuotaExhausted)
    }
}

// ─────────────────────────── 前端可见（掩码）视图 ───────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionKeyMasked {
    pub id: String,
    pub key_masked: String,
    pub status: KeyStatus,
    pub last_checked_at: Option<String>,
    pub quota_reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMasked {
    pub id: String,
    pub label: String,
    pub format: LlmFormat,
    pub base_url: String,
    pub keys: Vec<ConnectionKeyMasked>,
    pub models: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfigMasked {
    pub mode: LlmMode,
    pub connections: Vec<ConnectionMasked>,
    pub assignments: Assignments,
}

impl LlmConfig {
    /// 生成不含明文的前端视图。
    pub fn to_masked(&self) -> LlmConfigMasked {
        LlmConfigMasked {
            mode: self.mode,
            connections: self
                .connections
                .iter()
                .map(|c| ConnectionMasked {
                    id: c.id.clone(),
                    label: c.label.clone(),
                    format: c.format,
                    base_url: c.base_url.clone(),
                    keys: c
                        .keys
                        .iter()
                        .map(|k| ConnectionKeyMasked {
                            id: k.id.clone(),
                            key_masked: mask(&k.key),
                            status: k.status,
                            last_checked_at: k.last_checked_at.clone(),
                            quota_reset_at: k.quota_reset_at.clone(),
                        })
                        .collect(),
                    models: c.models.clone(),
                    enabled: c.enabled,
                })
                .collect(),
            assignments: self.assignments.clone(),
        }
    }

    pub fn connection(&self, id: &str) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id)
    }

    pub fn connection_mut(&mut self, id: &str) -> Option<&mut Connection> {
        self.connections.iter_mut().find(|c| c.id == id)
    }
}

// ─────────────────────────── 持久化 ───────────────────────────

/// 读取配置；不存在则返回默认（空连接、auto 模式）。
pub fn load(app: &AppHandle) -> LlmConfig {
    let Ok(store) = app.store(STORE_FILE) else {
        return LlmConfig::default();
    };
    match store.get(LLM_KEY) {
        Some(v) => serde_json::from_value(v).unwrap_or_default(),
        None => LlmConfig::default(),
    }
}

/// 保存配置。
pub fn save(app: &AppHandle, cfg: &LlmConfig) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("打开配置存储失败：{e}"))?;
    let v = serde_json::to_value(cfg).map_err(|e| format!("序列化配置失败：{e}"))?;
    store.set(LLM_KEY, v);
    store.save().map_err(|e| format!("写入配置失败：{e}"))?;
    Ok(())
}
