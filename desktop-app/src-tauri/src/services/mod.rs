//! 跨功能共享基础设施（无 UI，可被任意 feature 复用）。
//! 依赖方向：features → services；禁止反向、禁止 feature 互依赖。

pub mod llm;
pub mod secrets;
