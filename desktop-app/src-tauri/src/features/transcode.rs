//! 视频批量转码功能（首发模块）。
//! 调用内置 ffmpeg/ffprobe（sidecar），用信号量控制并发，逐文件向前端推送进度事件。
//!
//! 设计目标：上传短视频平台（抖音/TikTok/视频号等）前的「防二次压缩减伤」重编码。
//! - 平台一定会服务端重编码，无法绕过；我们只能喂高质量、规格对口的源，把损失降到最低。
//! - 默认「保原分辨率 + 保原帧率」，不盲目放大、不强行改帧率（这两者都会掉质）。
//! - 智能去黑边：用 cropdetect 探测，有黑边才裁，没黑边不动。
//! - 低 CRF = 高码率 = 减伤的真正杠杆；附带 bt709 颜色标签防偏色、+faststart 利于平台解析。

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

/// 批量转码的取消开关（应用级共享状态）。
#[derive(Default)]
pub struct TranscodeCancel(pub Arc<AtomicBool>);

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "ts"];
const PROGRESS_EVENT: &str = "transcode://progress";
const LOG_EVENT: &str = "transcode://log";
const VERIFY_EVENT: &str = "transcode://verify";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeParams {
    pub inputs: Vec<String>,
    pub output_dir: Option<String>,
    pub suffix: String,
    /// 编码器："h264"（默认，兼容最好）| "h265"（更小、有时走平台高清通道）
    pub codec: String,
    /// 画质 CRF，越小越清晰、码率越高（h264 推荐 16–18；h265 数值会自动 +2 折算）
    pub crf: u32,
    /// x264/x265 速度预设（ultrafast..slower）
    pub preset: String,
    /// 音频码率 kbps
    pub audio_bitrate: u32,
    /// 智能去黑边：cropdetect 探测，有黑边才裁
    pub smart_crop: bool,
    /// 限制到 1080p 以内（仅缩小、绝不放大）；关闭则完全保留原分辨率
    pub limit1080p: bool,
    /// 保留原始帧率；关闭则统一到 `fps`
    pub keep_fps: bool,
    /// 当 keep_fps == false 时使用的目标帧率
    pub fps: u32,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogLine {
    level: String, // info | error
    message: String,
}

/// 同时打到 dev 控制台（开发用）并推送到前端 UI 日志面板（用户可见）。
fn log(app: &AppHandle, level: &str, message: impl Into<String>) {
    let message = message.into();
    eprintln!("[transcode] {message}");
    let _ = app.emit(
        LOG_EVENT,
        LogLine {
            level: level.into(),
            message,
        },
    );
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

/// 取消正在进行的批量转码：置位取消开关，各任务会尽快停止并杀掉 ffmpeg 子进程。
#[tauri::command]
pub fn cancel_transcode(cancel: State<'_, TranscodeCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

/// 批量转码入口：受并发数限制，逐文件转码并推送进度。
#[tauri::command]
pub async fn transcode_batch(
    app: AppHandle,
    params: TranscodeParams,
    cancel: State<'_, TranscodeCancel>,
) -> Result<(), String> {
    let concurrency = params.concurrency.max(1);
    let sem = Arc::new(Semaphore::new(concurrency));
    let params = Arc::new(params);

    // 每次新批次开始前复位取消开关。
    let cancel = cancel.0.clone();
    cancel.store(false, Ordering::SeqCst);

    let mut handles = Vec::new();
    for input in params.inputs.clone() {
        let app = app.clone();
        let sem = sem.clone();
        let params = params.clone();
        let cancel = cancel.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = sem.acquire().await;
            // 取消后，尚未开始的文件直接标记为已取消。
            if cancel.load(Ordering::SeqCst) {
                emit(
                    &app,
                    Progress {
                        file: input.clone(),
                        status: "cancelled".into(),
                        percent: 0,
                        output_path: None,
                        message: Some("已取消".into()),
                    },
                );
                return;
            }
            if let Err(err) = transcode_one(&app, &params, &input, &cancel).await {
                log(&app, "error", format!("✗ 失败：{input}\n   原因：{err}"));
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
        .sidecar("ffprobe")
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

/// 用 ffprobe 读取视频宽高，用于判断是否需要缩放/裁剪。
async fn probe_dims(app: &AppHandle, input: &str) -> Option<(u32, u32)> {
    let cmd = app
        .shell()
        .sidecar("ffprobe")
        .ok()?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            input,
        ]);
    let output = cmd.output().await.ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    let s = s.trim();
    let mut it = s.split('x');
    let w = it.next()?.trim().parse().ok()?;
    let h = it.next()?.trim().parse().ok()?;
    Some((w, h))
}

/// 用 ffmpeg cropdetect 探测黑边，返回建议的 crop=(w,h,x,y)。
/// 只采样前 6 秒（跳过开头 2 秒避免片头），取最后一个稳定建议值。
async fn detect_crop(app: &AppHandle, input: &str, duration: f64) -> Option<(u32, u32, u32, u32)> {
    let ss = if duration > 4.0 { "2" } else { "0" };
    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .ok()?
        .args([
            "-hide_banner",
            "-nostats",
            "-ss",
            ss,
            "-i",
            input,
            "-t",
            "6",
            "-vf",
            "cropdetect=24:2:0",
            "-an",
            "-f",
            "null",
            "-",
        ]);
    let output = cmd.output().await.ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_last_crop(&stderr)
}

/// 从 cropdetect 的 stderr 中解析最后一个 `crop=w:h:x:y`。
fn parse_last_crop(s: &str) -> Option<(u32, u32, u32, u32)> {
    let mut last = None;
    let mut search_from = 0usize;
    while let Some(rel) = s[search_from..].find("crop=") {
        let start = search_from + rel + "crop=".len();
        let rest = &s[start..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == ':'))
            .unwrap_or(rest.len());
        let token = &rest[..end];
        let parts: Vec<&str> = token.split(':').collect();
        if parts.len() == 4 {
            if let (Ok(w), Ok(h), Ok(x), Ok(y)) = (
                parts[0].parse::<u32>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<u32>(),
                parts[3].parse::<u32>(),
            ) {
                if w > 0 && h > 0 {
                    last = Some((w, h, x, y));
                }
            }
        }
        search_from = start;
    }
    last
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
    let mut out = dir.join(file_name);

    // 安全护栏：绝不让产物路径等于源文件（空后缀 + 同目录 + 源本身是 .mp4 时会发生），
    // 否则 ffmpeg -y 会原地覆盖甚至边读边写损坏源文件。命中则强制追加 _out。
    if same_path(&out, &in_path) {
        out = dir.join(format!("{}_out.mp4", stem));
    }
    out
}

/// 路径等价判断：Windows 文件系统大小写不敏感，统一转小写比较。
fn same_path(a: &PathBuf, b: &PathBuf) -> bool {
    let na = a.to_string_lossy().to_lowercase().replace('/', "\\");
    let nb = b.to_string_lossy().to_lowercase().replace('/', "\\");
    na == nb
}

/// 组装 ffmpeg 的 -vf 滤镜链（可能为空）。返回 None 表示无需任何滤镜（纯重编码）。
async fn build_filter_chain(
    app: &AppHandle,
    params: &TranscodeParams,
    input: &str,
    duration: f64,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    let dims = probe_dims(app, input).await;

    // 1) 智能去黑边：仅当探测到的裁剪框明显小于原始尺寸时才裁。
    if params.smart_crop {
        if let Some((cw, ch, cx, cy)) = detect_crop(app, input, duration).await {
            let shrinks = match dims {
                Some((w, h)) => (w.saturating_sub(cw) >= 4) || (h.saturating_sub(ch) >= 4),
                None => true,
            };
            if shrinks {
                parts.push(format!("crop={cw}:{ch}:{cx}:{cy}"));
            }
        }
    }

    // 2) 限制到 1080×1920 以内：仅缩小、绝不放大；保持宽高比；宽高强制为偶数。
    if params.limit1080p {
        let need = match dims {
            Some((w, h)) => w > 1080 || h > 1920,
            None => true,
        };
        // smart_crop 裁剪后尺寸可能变化，这里用 min(原尺寸,上限) 作为目标盒，decrease 只会缩小。
        if need || params.smart_crop {
            parts.push(
                "scale=w='min(1080,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos"
                    .to_string(),
            );
        }
    }

    // 3) 帧率：默认保留原始帧率；仅当用户关闭「保原帧率」时才统一。
    if !params.keep_fps {
        parts.push(format!("fps={}", params.fps));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

async fn transcode_one(
    app: &AppHandle,
    params: &TranscodeParams,
    input: &str,
    cancel: &Arc<AtomicBool>,
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

    // 同名产物覆盖提示（不阻断，仅告知）。
    if output.exists() {
        log(app, "info", format!("  ⚠ 覆盖已存在文件：{output_str}"));
    }

    let vf = build_filter_chain(app, params, input, duration).await;

    // ── 组装 ffmpeg 参数 ──
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input.into(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
    ];

    if let Some(vf) = &vf {
        args.push("-vf".into());
        args.push(vf.clone());
    }

    // 视频编码：低 CRF 提供高码率源（减伤核心）；附带颜色标签防偏色。
    let is_h265 = params.codec.eq_ignore_ascii_case("h265")
        || params.codec.eq_ignore_ascii_case("hevc");
    if is_h265 {
        // x265 的 CRF 比 x264 偏高约 +2 才等效画质，这里自动折算，前端只需给一个值。
        let crf = params.crf + 2;
        args.extend([
            "-c:v".into(),
            "libx265".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-crf".into(),
            crf.to_string(),
            "-preset".into(),
            params.preset.clone(),
            // hvc1 标记利于 Apple 生态与各平台识别。
            "-tag:v".into(),
            "hvc1".into(),
        ]);
    } else {
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-profile:v".into(),
            "high".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-crf".into(),
            params.crf.to_string(),
            "-preset".into(),
            params.preset.clone(),
        ]);
    }

    // 颜色标签统一 bt709（1080p 通行标准），避免上传后发灰/偏色。
    args.extend([
        "-colorspace".into(),
        "bt709".into(),
        "-color_primaries".into(),
        "bt709".into(),
        "-color_trc".into(),
        "bt709".into(),
    ]);

    // 音频 + 容器优化 + 进度输出。
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{}k", params.audio_bitrate),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        output_str.clone(),
    ]);

    log(app, "info", format!("▶ 开始：{input}"));
    log(app, "info", format!("   输出：{output_str}"));
    log(
        app,
        "info",
        format!("   ffmpeg {}", args.join(" ")),
    );

    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("找不到内置 ffmpeg：{e}"))?
        .args(args);

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
    let mut child = Some(child);

    let mut last_err = String::new();
    while let Some(event) = rx.recv().await {
        // 收到取消信号：杀掉 ffmpeg 子进程并标记为已取消。
        if cancel.load(Ordering::SeqCst) {
            if let Some(c) = child.take() {
                let _ = c.kill();
            }
            log(app, "info", format!("■ 已取消：{input}"));
            emit(
                app,
                Progress {
                    file: input.to_string(),
                    status: "cancelled".into(),
                    percent: 0,
                    output_path: None,
                    message: Some("已取消".into()),
                },
            );
            return Ok(());
        }
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
                    log(app, "info", format!("✓ 完成：{output_str}"));
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
                    // 处理后自动验证（只读 metadata + 64KB 文件头，开销极小）
                    let report = verify_output(app, params, input, &output_str).await;
                    log(
                        app,
                        if report.overall == "fail" { "error" } else { "info" },
                        format!(
                            "  ⤷ 验证：{}（{} 通过 / {} 警告 / {} 失败）",
                            report.overall,
                            report.items.iter().filter(|i| i.status == "ok").count(),
                            report.items.iter().filter(|i| i.status == "warn").count(),
                            report.items.iter().filter(|i| i.status == "fail").count(),
                        ),
                    );
                    let _ = app.emit(VERIFY_EVENT, &report);
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

// ───────────────────────── 处理后验证 ─────────────────────────

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerifyItem {
    key: String,
    label: String,
    status: String, // ok | warn | fail
    expected: String,
    actual: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerifyReport {
    file: String,
    output_path: String,
    overall: String, // ok | warn | fail
    items: Vec<VerifyItem>,
}

/// 跑一次 ffprobe，把 `key=value` 输出解析成 map（只读 metadata，不解码）。
async fn probe_kv(
    app: &AppHandle,
    path: &str,
    select: Option<&str>,
    entries: &str,
) -> HashMap<String, String> {
    let mut args: Vec<String> = vec!["-v".into(), "error".into()];
    if let Some(sel) = select {
        args.push("-select_streams".into());
        args.push(sel.into());
    }
    args.push("-show_entries".into());
    args.push(entries.into());
    args.push("-of".into());
    args.push("default=noprint_wrappers=1".into());
    args.push(path.into());

    let mut map = HashMap::new();
    let cmd = match app.shell().sidecar("ffprobe") {
        Ok(c) => c.args(args),
        Err(_) => return map,
    };
    if let Ok(output) = cmd.output().await {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    map
}

fn kv<'a>(m: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    m.get(key).map(|s| s.as_str()).filter(|s| {
        let s = s.trim();
        !s.is_empty() && !s.eq_ignore_ascii_case("N/A")
    })
}

fn parse_rate(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/').unwrap_or((s, "1"));
    let a: f64 = a.trim().parse().ok()?;
    let b: f64 = b.trim().parse().ok()?;
    if b == 0.0 {
        None
    } else {
        Some(a / b)
    }
}

/// 只读文件头 64KB 判断 moov 是否前置（faststart）。
fn check_faststart(path: &str) -> Option<bool> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 65536];
    let n = f.read(&mut buf).ok()?;
    let head = &buf[..n];
    let find = |needle: &[u8]| head.windows(needle.len()).position(|w| w == needle);
    match (find(b"moov"), find(b"mdat")) {
        (Some(m), Some(d)) => Some(m < d),
        (Some(_), None) => Some(true), // moov 在头部、mdat 在更后面
        _ => None,
    }
}

fn item(key: &str, label: &str, status: &str, expected: String, actual: String) -> VerifyItem {
    VerifyItem {
        key: key.into(),
        label: label.into(),
        status: status.into(),
        expected,
        actual,
    }
}

/// 对处理后的视频逐项验证，返回结构化报告。
async fn verify_output(
    app: &AppHandle,
    params: &TranscodeParams,
    input: &str,
    output: &str,
) -> VerifyReport {
    // 原片信息
    let ov = probe_kv(app, input, Some("v:0"), "stream=width,height,avg_frame_rate,bit_rate").await;
    let of = probe_kv(app, input, None, "format=duration,bit_rate").await;
    // 处理后信息
    let nv = probe_kv(
        app,
        output,
        Some("v:0"),
        "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,bit_rate,color_space,color_primaries,color_transfer",
    )
    .await;
    let nf = probe_kv(app, output, None, "format=duration,bit_rate").await;
    let na = probe_kv(app, output, Some("a:0"), "stream=codec_name,bit_rate").await;

    let mut items: Vec<VerifyItem> = Vec::new();

    // 1) 视频编码
    let is_h265 = params.codec.eq_ignore_ascii_case("h265") || params.codec.eq_ignore_ascii_case("hevc");
    let expect_codec = if is_h265 { "hevc" } else { "h264" };
    let actual_codec = kv(&nv, "codec_name").unwrap_or("?");
    items.push(item(
        "codec",
        "视频编码",
        if actual_codec.eq_ignore_ascii_case(expect_codec) { "ok" } else { "fail" },
        expect_codec.to_uppercase(),
        format!(
            "{}{}",
            actual_codec.to_uppercase(),
            kv(&nv, "profile").map(|p| format!(" ({p})")).unwrap_or_default()
        ),
    ));

    // 2) 像素格式
    let pix = kv(&nv, "pix_fmt").unwrap_or("?");
    items.push(item(
        "pix_fmt",
        "像素格式",
        if pix == "yuv420p" { "ok" } else { "warn" },
        "yuv420p".into(),
        pix.into(),
    ));

    // 3) 颜色标签 bt709
    let cs = kv(&nv, "color_space").unwrap_or("");
    let cp = kv(&nv, "color_primaries").unwrap_or("");
    let ct = kv(&nv, "color_transfer").unwrap_or("");
    let color_ok = cs == "bt709" && cp == "bt709" && ct == "bt709";
    items.push(item(
        "color",
        "颜色标签",
        if color_ok { "ok" } else { "warn" },
        "bt709 (三标签)".into(),
        format!("{cs}/{cp}/{ct}"),
    ));

    // 4) faststart
    let fs = check_faststart(output);
    items.push(item(
        "faststart",
        "faststart（moov 前置）",
        match fs { Some(true) => "ok", Some(false) => "fail", None => "warn" },
        "开启".into(),
        match fs {
            Some(true) => "moov 前置".to_string(),
            Some(false) => "moov 在尾部".to_string(),
            None => "未知".to_string(),
        },
    ));

    // 5) 视频码率（减伤=应高于原片）
    let ov_br = kv(&nv, "bit_rate").and_then(|s| s.parse::<u64>().ok())
        .or_else(|| kv(&nf, "bit_rate").and_then(|s| s.parse::<u64>().ok()));
    let orig_br = kv(&ov, "bit_rate").and_then(|s| s.parse::<u64>().ok())
        .or_else(|| kv(&of, "bit_rate").and_then(|s| s.parse::<u64>().ok()));
    let (br_status, br_actual) = match (ov_br, orig_br) {
        (Some(n), Some(o)) => (
            if n > o { "ok" } else { "warn" },
            format!("{:.2} Mbps（原片 {:.2} Mbps，{:.1}×）", n as f64 / 1e6, o as f64 / 1e6, n as f64 / o.max(1) as f64),
        ),
        (Some(n), None) => ("ok", format!("{:.2} Mbps", n as f64 / 1e6)),
        _ => ("warn", "未知".into()),
    };
    items.push(item("bitrate", "视频码率（应高于原片）", br_status, "高于原片".into(), br_actual));

    // 6) 分辨率（不放大；limit1080p 时不超过 1080×1920）
    let ow = kv(&nv, "width").and_then(|s| s.parse::<u32>().ok());
    let oh = kv(&nv, "height").and_then(|s| s.parse::<u32>().ok());
    let sw = kv(&ov, "width").and_then(|s| s.parse::<u32>().ok());
    let sh = kv(&ov, "height").and_then(|s| s.parse::<u32>().ok());
    let res_actual = format!("{}×{}", ow.unwrap_or(0), oh.unwrap_or(0));
    let res_status = match (ow, oh, sw, sh) {
        (Some(w), Some(h), Some(w0), Some(h0)) => {
            let upscaled = w > w0 || h > h0; // 绝不该放大
            let over_box = params.limit1080p && (w > 1080 || h > 1920);
            if upscaled || over_box { "fail" } else { "ok" }
        }
        _ => "warn",
    };
    let res_expect = if params.limit1080p { "≤1080×1920，不放大" } else { "保持原分辨率" };
    items.push(item("resolution", "分辨率", res_status, res_expect.into(), res_actual));

    // 7) 帧率
    let ofps = kv(&nv, "avg_frame_rate").and_then(parse_rate);
    let sfps = kv(&ov, "avg_frame_rate").and_then(parse_rate);
    let (fps_status, fps_expect) = if params.keep_fps {
        let ok = matches!((ofps, sfps), (Some(a), Some(b)) if (a - b).abs() < 0.5);
        (if ok { "ok" } else if ofps.is_none() { "warn" } else { "fail" }, "保持原帧率".to_string())
    } else {
        let ok = matches!(ofps, Some(a) if (a - params.fps as f64).abs() < 0.5);
        (if ok { "ok" } else { "fail" }, format!("{} fps", params.fps))
    };
    items.push(item("fps", "帧率", fps_status, fps_expect, ofps.map(|f| format!("{f:.0} fps")).unwrap_or_else(|| "未知".into())));

    // 8) 音频编码
    let acodec = kv(&na, "codec_name").unwrap_or("?");
    items.push(item(
        "audio_codec",
        "音频编码",
        if acodec.eq_ignore_ascii_case("aac") { "ok" } else { "warn" },
        "AAC".into(),
        acodec.to_uppercase(),
    ));

    // 9) 音频码率（单声道 AAC 自限，≥96k 视为达标）
    let abr = kv(&na, "bit_rate").and_then(|s| s.parse::<u64>().ok());
    let (abr_status, abr_actual) = match abr {
        Some(n) => (if n >= 96_000 { "ok" } else { "warn" }, format!("{} kbps", n / 1000)),
        None => ("warn", "未知".into()),
    };
    items.push(item("audio_bitrate", "音频码率", abr_status, format!("目标 {} kbps", params.audio_bitrate), abr_actual));

    // 10) 时长一致
    let od = kv(&nf, "duration").and_then(|s| s.parse::<f64>().ok());
    let sd = kv(&of, "duration").and_then(|s| s.parse::<f64>().ok());
    let dur_status = match (od, sd) {
        (Some(a), Some(b)) => if (a - b).abs() < 0.3 { "ok" } else { "warn" },
        _ => "warn",
    };
    items.push(item(
        "duration",
        "时长一致",
        dur_status,
        sd.map(|d| format!("{d:.2}s")).unwrap_or_else(|| "原片".into()),
        od.map(|d| format!("{d:.2}s")).unwrap_or_else(|| "未知".into()),
    ));

    let overall = if items.iter().any(|i| i.status == "fail") {
        "fail"
    } else if items.iter().any(|i| i.status == "warn") {
        "warn"
    } else {
        "ok"
    };

    VerifyReport {
        file: input.to_string(),
        output_path: output.to_string(),
        overall: overall.into(),
        items,
    }
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
