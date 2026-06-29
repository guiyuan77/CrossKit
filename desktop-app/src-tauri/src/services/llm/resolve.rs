//! 指派解析：taskId → (连接, 模型)。
//! 回退顺序：任务覆盖 → 模块默认 → 全局默认。

use super::config::{LlmConfig, ModelRef};
use super::tasks::module_of;

/// 解析某任务该用的 ModelRef（仅查表，不校验连接是否可用）。
pub fn resolve_ref(cfg: &LlmConfig, task_id: &str) -> Option<ModelRef> {
    let a = &cfg.assignments;
    if let Some(m) = a.overrides.get(task_id) {
        return Some(m.clone());
    }
    let module_id = module_of(task_id);
    if let Some(m) = a.overrides.get(&module_id) {
        return Some(m.clone());
    }
    a.global.clone()
}
