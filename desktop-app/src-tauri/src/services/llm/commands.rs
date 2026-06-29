//! LLM 网关的 IPC 命令。**只进出掩码数据**：明文 key 永不出后端。
//! 在 `lib.rs` 的 `invoke_handler!` 注册。

use serde::Serialize;
use tauri::{AppHandle, State};

use super::adapters::adapter_for;
use super::config::{
    self, Connection, ConnectionKey, KeyStatus, LlmConfigMasked, LlmFormat, LlmMode, ModelRef,
};
use super::tasks::{self, LlmTask};
use super::{LlmError, LlmState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub status: KeyStatus,
    pub models: Vec<String>,
    pub quota_reset_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub connected: bool,
    pub active_model: Option<String>,
    pub mode: LlmMode,
}

/// 读取全量配置（掩码）。
#[tauri::command]
pub fn llm_list_config(app: AppHandle) -> LlmConfigMasked {
    config::load(&app).to_masked()
}

/// 列出任务注册表（驱动指派表 UI）。
#[tauri::command]
pub fn llm_list_tasks() -> Vec<LlmTask> {
    tasks::all()
}

/// 切换模式（auto / api / weblink）。
#[tauri::command]
pub fn llm_set_mode(app: AppHandle, mode: LlmMode) -> Result<LlmConfigMasked, String> {
    let mut cfg = config::load(&app);
    cfg.mode = mode;
    config::save(&app, &cfg)?;
    Ok(cfg.to_masked())
}

/// 设置/清除指派。scope = "global" 或 moduleId / taskId；model_ref=None 表示清除（回退上级）。
#[tauri::command]
pub fn llm_set_assignment(
    app: AppHandle,
    scope: String,
    model_ref: Option<ModelRef>,
) -> Result<LlmConfigMasked, String> {
    let mut cfg = config::load(&app);
    if scope == "global" {
        cfg.assignments.global = model_ref;
    } else if let Some(m) = model_ref {
        cfg.assignments.overrides.insert(scope, m);
    } else {
        cfg.assignments.overrides.remove(&scope);
    }
    config::save(&app, &cfg)?;
    Ok(cfg.to_masked())
}

/// 添加连接（含一个 key）。新增后即返回掩码连接；建议前端随后调用测试。
#[tauri::command]
pub fn llm_add_connection(
    app: AppHandle,
    label: String,
    format: LlmFormat,
    base_url: String,
    key: String,
) -> Result<LlmConfigMasked, String> {
    let mut cfg = config::load(&app);
    let base_url = if base_url.trim().is_empty() && format == LlmFormat::Gemini {
        "https://generativelanguage.googleapis.com".to_string()
    } else {
        base_url.trim().to_string()
    };
    let conn = Connection {
        id: format!("conn_{}", uuid::Uuid::new_v4().simple()),
        label: label.trim().to_string(),
        format,
        base_url,
        keys: vec![ConnectionKey {
            id: format!("k_{}", uuid::Uuid::new_v4().simple()),
            key: key.trim().to_string(),
            status: KeyStatus::Unknown,
            last_checked_at: None,
            quota_reset_at: None,
        }],
        models: Vec::new(),
        enabled: true,
    };
    cfg.connections.push(conn);
    config::save(&app, &cfg)?;
    Ok(cfg.to_masked())
}

/// 编辑连接（部分字段）。传 `key` 非空则替换首个 key 的明文。
#[tauri::command]
pub fn llm_update_connection(
    app: AppHandle,
    id: String,
    label: Option<String>,
    base_url: Option<String>,
    models: Option<Vec<String>>,
    enabled: Option<bool>,
    key: Option<String>,
) -> Result<LlmConfigMasked, String> {
    let mut cfg = config::load(&app);
    {
        let conn = cfg
            .connection_mut(&id)
            .ok_or_else(|| "连接不存在".to_string())?;
        if let Some(v) = label {
            conn.label = v.trim().to_string();
        }
        if let Some(v) = base_url {
            conn.base_url = v.trim().to_string();
        }
        if let Some(v) = models {
            conn.models = v;
        }
        if let Some(v) = enabled {
            conn.enabled = v;
        }
        if let Some(k) = key {
            let k = k.trim().to_string();
            if !k.is_empty() {
                if let Some(first) = conn.keys.first_mut() {
                    first.key = k;
                    first.status = KeyStatus::Unknown;
                    first.quota_reset_at = None;
                } else {
                    conn.keys.push(ConnectionKey {
                        id: format!("k_{}", uuid::Uuid::new_v4().simple()),
                        key: k,
                        status: KeyStatus::Unknown,
                        last_checked_at: None,
                        quota_reset_at: None,
                    });
                }
            }
        }
    }
    config::save(&app, &cfg)?;
    Ok(cfg.to_masked())
}

/// 删除连接。
#[tauri::command]
pub fn llm_delete_connection(app: AppHandle, id: String) -> Result<LlmConfigMasked, String> {
    let mut cfg = config::load(&app);
    cfg.connections.retain(|c| c.id != id);
    // 顺带清理引用了该连接的指派
    if let Some(g) = &cfg.assignments.global {
        if g.conn_id == id {
            cfg.assignments.global = None;
        }
    }
    cfg.assignments.overrides.retain(|_, m| m.conn_id != id);
    config::save(&app, &cfg)?;
    Ok(cfg.to_masked())
}

/// 测试连接（调 list_models）。成功=key 有效，并回填可用模型。
#[tauri::command]
pub async fn llm_test_connection(
    app: AppHandle,
    state: State<'_, LlmState>,
    id: String,
) -> Result<TestResult, String> {
    let cfg = config::load(&app);
    let conn = cfg
        .connection(&id)
        .cloned()
        .ok_or_else(|| "连接不存在".to_string())?;
    let adapter = adapter_for(conn.format);
    let result = adapter.list_models(&state.client, &conn).await;

    let mut cfg2 = config::load(&app);
    let test = match result {
        Ok(models) => {
            if let Some(c) = cfg2.connection_mut(&id) {
                if !models.is_empty() {
                    c.models = models.clone();
                }
                if let Some(k) = c.keys.first_mut() {
                    k.status = KeyStatus::Valid;
                    k.quota_reset_at = None;
                }
            }
            TestResult {
                status: KeyStatus::Valid,
                models,
                quota_reset_at: None,
                message: None,
            }
        }
        Err(e) => {
            let status = match &e {
                LlmError::QuotaExhausted { .. } => KeyStatus::QuotaExhausted,
                LlmError::Auth => KeyStatus::Invalid,
                _ => KeyStatus::Unknown,
            };
            if let Some(c) = cfg2.connection_mut(&id) {
                if let Some(k) = c.keys.first_mut() {
                    k.status = status;
                }
            }
            TestResult {
                status,
                models: Vec::new(),
                quota_reset_at: None,
                message: Some(e.to_string()),
            }
        }
    };
    config::save(&app, &cfg2)?;
    Ok(test)
}

/// 拉取可用模型列表。
#[tauri::command]
pub async fn llm_fetch_models(
    app: AppHandle,
    state: State<'_, LlmState>,
    id: String,
) -> Result<Vec<String>, String> {
    let cfg = config::load(&app);
    let conn = cfg
        .connection(&id)
        .cloned()
        .ok_or_else(|| "连接不存在".to_string())?;
    let adapter = adapter_for(conn.format);
    adapter
        .list_models(&state.client, &conn)
        .await
        .map_err(|e| e.to_string())
}

/// 全局 AI 连接状态（给侧边栏小圆点用）。
#[tauri::command]
pub fn llm_status(app: AppHandle) -> StatusInfo {
    let cfg = config::load(&app);
    if cfg.mode == LlmMode::Weblink {
        return StatusInfo {
            connected: false,
            active_model: None,
            mode: cfg.mode,
        };
    }
    let connected = cfg
        .assignments
        .global
        .as_ref()
        .and_then(|g| cfg.connection(&g.conn_id).map(|c| (c, g)))
        .map(|(c, _)| c.enabled && c.usable_key().is_some())
        .unwrap_or(false);
    let active_model = if connected {
        cfg.assignments.global.as_ref().map(|g| g.model.clone())
    } else {
        None
    };
    StatusInfo {
        connected,
        active_model,
        mode: cfg.mode,
    }
}
