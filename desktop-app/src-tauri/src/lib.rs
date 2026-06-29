mod features;
mod services;

use features::{deconstructor, transcode};
use services::llm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    // 自动更新 / 重启：仅桌面端注册
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        // 应用级共享状态：批量转码取消开关 + LLM 网关（HTTP 客户端复用）
        .manage(transcode::TranscodeCancel::default())
        .manage(llm::LlmState::default())
        .manage(deconstructor::DeconstructCancel::default())
        // ── 命令注册中心：新功能在这里追加 handler ──
        .invoke_handler(tauri::generate_handler![
            transcode::list_videos_in_folder,
            transcode::transcode_batch,
            transcode::cancel_transcode,
            // LLM 网关（P0）
            llm::commands::llm_list_config,
            llm::commands::llm_list_tasks,
            llm::commands::llm_set_mode,
            llm::commands::llm_set_assignment,
            llm::commands::llm_add_connection,
            llm::commands::llm_update_connection,
            llm::commands::llm_delete_connection,
            llm::commands::llm_test_connection,
            llm::commands::llm_fetch_models,
            llm::commands::llm_status,
            // 对标拆解器（P1 · 阶段 A）
            deconstructor::deconstruct_start,
            deconstructor::deconstruct_cancel,
            deconstructor::deconstruct_build_external,
            deconstructor::deconstruct_ingest_external,
            deconstructor::deconstruct_load_report,
            deconstructor::deconstruct_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
