//! 视频批量转码功能（首发模块）。
//! 调用内置 ffmpeg/ffprobe（sidecar），用信号量控制并发，逐文件向前端推送进度事件。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "ts"];
const PROGRESS_EVENT: &str = "transcode://progress";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeParams {
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub suffix: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub crf: u32,
    pub preset: String,
    pub audio_bitrate: u32,
    pub concurrency: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    file: String,
    status: String, // pending | running | done | error
    percent: u32,
    output_path: Option<String>,
    message: Option<String>,
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit(PROGRESS_EVENT, p);
}

/// 收集文件夹（含子目录）下的所有视频文件路径。
#[tauri::command]
pub fn list_videos_in_folder(folder: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&folder).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
            if VIDEO_EXTS.contains(&ext.to_lowercase().as_str()) {
                out.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    Ok(out)
}

/// 批量转码入口：受并发数限制，逐文件转码并推送进度。
#[tauri::command]
pub async fn transcode_batch(app: AppHandle, params: TranscodeParams) -> Result<(), String> {
    let concurrency = params.concurrency.max(1);
    let sem = Arc::new(Semaphore::new(concurrency));
    let params = Arc::new(params);

    let mut handles = Vec::new();
    for input in params.inputs.clone() {
        let app = app.clone();
        let sem = sem.clone();
        let params = params.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = sem.acquire().await;
            if let Err(err) = transcode_one(&app, &params, &input).await {
                emit(
                    &app,
                    Progress {
                        file: input.clone(),
                        status: "error".into(),
                        percent: 0,
                        output_path: None,
                        message: Some(err),
                    },
                );
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

/// 用 ffprobe 读取视频总时长（秒），用于计算进度百分比。
async fn probe_duration(app: &AppHandle, input: &str) -> Option<f64> {
    let cmd = app
        .shell()
        .sidecar("binaries/ffprobe")
        .ok()?
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            input,
        ]);
    let output = cmd.output().await.ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    s.trim().parse::<f64>().ok()
}

fn build_output_path(params: &TranscodeParams, input: &str) -> PathBuf {
    let in_path = PathBuf::from(input);
    let stem = in_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    let file_name = format!("{}{}.mp4", stem, params.suffix);

    let dir = match &params.output_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => in_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".")),
    };
    dir.join(file_name)
}

async fn transcode_one(
    app: &AppHandle,
    params: &TranscodeParams,
    input: &str,
) -> Result<(), String> {
    emit(
        app,
        Progress {
            file: input.to_string(),
            status: "running".into(),
            percent: 0,
            output_path: None,
            message: None,
        },
    );

    let duration = probe_duration(app, input).await.unwrap_or(0.0);
    let output = build_output_path(params, input);
    let output_str = output.to_string_lossy().to_string();

    // 等比放大到目标尺寸后居中裁剪，lanczos 算法，统一帧率。
    let vf = format!(
        "scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},fps={fps}",
        w = params.width,
        h = params.height,
        fps = params.fps
    );

    let cmd = app
        .shell()
        .sidecar("binaries/ffmpeg")
        .map_err(|e| format!("找不到内置 ffmpeg：{e}"))?
        .args([
            "-y",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            &vf,
            "-c:v",
            "libx264",
            "-crf",
            &params.crf.to_string(),
            "-preset",
            &params.preset,
            "-c:a",
            "aac",
            "-b:a",
            &format!("{}k", params.audio_bitrate),
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            &output_str,
        ]);

    let (mut rx, _child) = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;

    let mut last_err = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                if let Some(percent) = parse_progress_percent(&text, duration) {
                    emit(
                        app,
                        Progress {
                            file: input.to_string(),
                            status: "running".into(),
                            percent,
                            output_path: None,
                            message: None,
                        },
                    );
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                if !text.trim().is_empty() {
                    last_err = text.trim().to_string();
                }
            }
            CommandEvent::Terminated(payload) => {
                if payload.code == Some(0) {
                    emit(
                        app,
                        Progress {
                            file: input.to_string(),
                            status: "done".into(),
                            percent: 100,
                            output_path: Some(output_str.clone()),
                            message: None,
                        },
                    );
                    return Ok(());
                } else {
                    return Err(if last_err.is_empty() {
                        format!("ffmpeg 退出码 {:?}", payload.code)
                    } else {
                        last_err
                    });
                }
            }
            _ => {}
        }
    }

    Ok(())
}

/// 解析 ffmpeg `-progress pipe:1` 输出中的 out_time_us / out_time_ms，计算百分比。
fn parse_progress_percent(text: &str, duration: f64) -> Option<u32> {
    if duration <= 0.0 {
        return None;
    }
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                let pct = ((us / 1_000_000.0) / duration * 100.0).clamp(0.0, 99.0);
                return Some(pct as u32);
            }
        }
        if let Some(v) = line.strip_prefix("out_time_ms=") {
            if let Ok(ms) = v.trim().parse::<f64>() {
                // 注意：部分 ffmpeg 版本此字段实为微秒，这里按微秒处理更稳妥。
                let pct = ((ms / 1_000_000.0) / duration * 100.0).clamp(0.0, 99.0);
                return Some(pct as u32);
            }
        }
    }
    None
}
