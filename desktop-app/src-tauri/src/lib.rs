mod features;

use features::transcode;

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
        // 应用级共享状态：批量转码取消开关
        .manage(transcode::TranscodeCancel::default())
        // ── 命令注册中心：新功能在这里追加 handler ──
        .invoke_handler(tauri::generate_handler![
            transcode::list_videos_in_folder,
            transcode::transcode_batch,
            transcode::cancel_transcode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
