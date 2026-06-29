//! 任务注册表：各功能在此声明自己用到的 LLM 任务（taskId）。
//! 用户在设置页"模型指派表"里就能给每个任务单独指派模型。
//!
//! 约定：taskId = `<moduleId>.<task>`，例如 `deconstructor.hook`。
//! 新功能要用 AI：在 `BUILTIN_TASKS` 里加几行即可，无需改动网关其它部分。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTask {
    pub id: String,
    pub module_id: String,
    pub module_label: String,
    pub label: String,
    pub needs_vision: bool,
}

fn task(id: &str, module_id: &str, module_label: &str, label: &str, needs_vision: bool) -> LlmTask {
    LlmTask {
        id: id.to_string(),
        module_id: module_id.to_string(),
        module_label: module_label.to_string(),
        label: label.to_string(),
        needs_vision,
    }
}

/// 全部已注册任务。指派表按 `module_id` 分组展示。
pub fn all() -> Vec<LlmTask> {
    vec![
        // ── 对标拆解器（P1）──
        task(
            "deconstructor.hook",
            "deconstructor",
            "对标拆解器",
            "钩子分析（前3秒）",
            true,
        ),
        task(
            "deconstructor.shots",
            "deconstructor",
            "对标拆解器",
            "分镜描述",
            true,
        ),
        task(
            "deconstructor.decon",
            "deconstructor",
            "对标拆解器",
            "三层拆解 + 人物画像",
            true,
        ),
    ]
}

/// 由 taskId 取 moduleId（用于指派三级回退：task → module → global）。
pub fn module_of(task_id: &str) -> String {
    match task_id.split_once('.') {
        Some((m, _)) => m.to_string(),
        None => task_id.to_string(),
    }
}
