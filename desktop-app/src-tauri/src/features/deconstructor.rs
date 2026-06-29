//! 对标拆解器（P1）后端 —— 阶段 A：本地视觉链 + LLM 网关 + 外链兜底 + 报告。
//!
//! 设计见 `docs/features/01-对标拆解器/DESIGN.md`。
//! 流水线：probe → scene_detect → keyframe → rhythm →（asr 阶段 B 接 whisper，暂 skipped）
//!         → llm（经 P0 网关三层合并；无 key/限流则标 needsWeblink 由前端走外链）→ assemble。
//! 报告落盘：`<appData>/deconstructor/<runId>/report.json`，关键帧在 `frames/`。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;

use crate::services::llm::{self, AnalyzeRequest, LlmError, LlmState};

const SCHEMA_VERSION: &str = "1.0";
const PROGRESS_EVENT: &str = "deconstruct://progress";
const LOG_EVENT: &str = "deconstruct://log";
const DONE_EVENT: &str = "deconstruct://done";

/// 拆解流水线取消开关（应用级共享状态）。
#[derive(Default)]
pub struct DeconstructCancel(pub Arc<AtomicBool>);

// ─────────────────────────── 入参 ───────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeconstructParams {
    pub input: String,
    #[serde(default = "default_hook_window")]
    pub hook_window_sec: f64,
    #[serde(default = "default_scene")]
    pub scene_threshold: f64,
    #[serde(default = "default_max_frames")]
    pub max_frames: usize,
}
fn default_hook_window() -> f64 {
    3.0
}
fn default_scene() -> f64 {
    0.3
}
fn default_max_frames() -> usize {
    12
}

// ─────────────────────────── 产物契约 ───────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    pub filename: String,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub lang: String,
    pub full_text: String,
    pub segments: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub duration_sec: f64,
    pub keyframe_path: Option<String>,
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rhythm {
    pub shot_count: usize,
    pub avg_shot_sec: f64,
    pub cuts_per_min: f64,
    pub fastest_shot_sec: f64,
    pub tempo_curve: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    pub id: String,
    pub status: String, // pending | running | done | failed | skipped
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkeletonReport {
    pub schema_version: String,
    pub run_id: String,
    pub generated_at: String,
    pub status: String, // completed | partial | error
    pub source: Source,
    pub transcript: Transcript,
    pub shots: Vec<Shot>,
    pub rhythm: Rhythm,
    pub hook: Option<Value>,
    pub deconstruction: Option<Value>,
    pub reusable_module: Option<String>,
    pub character_profile: Option<Value>,
    pub emotion_order: Vec<String>,
    pub full_voiceover: String,
    pub stages: Vec<StageState>,
    pub warnings: Vec<String>,
    /// 额外给 UI：true 表示智能半需走外链面板。
    pub needs_weblink: bool,
}

// ─────────────────────────── 事件 ───────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    run_id: &'a str,
    stage_id: &'a str,
    status: &'a str,
    percent: u32,
    message: Option<String>,
}

fn emit_progress(app: &AppHandle, run_id: &str, stage: &str, status: &str, percent: u32, msg: Option<String>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressPayload {
            run_id,
            stage_id: stage,
            status,
            percent,
            message: msg,
        },
    );
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogLine {
    level: String,
    message: String,
}

fn log(app: &AppHandle, level: &str, message: impl Into<String>) {
    let message = message.into();
    eprintln!("[deconstruct] {message}");
    let _ = app.emit(
        LOG_EVENT,
        LogLine {
            level: level.into(),
            message,
        },
    );
}

fn now_unix_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

// ─────────────────────────── 命令：启动 / 取消 ───────────────────────────

/// 启动一次拆解流水线，立即返回 runId；进度经 `deconstruct://progress` 推送，完成发 `deconstruct://done`。
#[tauri::command]
pub async fn deconstruct_start(
    app: AppHandle,
    state: State<'_, LlmState>,
    cancel: State<'_, DeconstructCancel>,
    params: DeconstructParams,
) -> Result<String, String> {
    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let client = state.client.clone();
    let cancel = cancel.0.clone();
    cancel.store(false, Ordering::SeqCst);

    let app2 = app.clone();
    let rid = run_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_pipeline(&app2, &client, &cancel, &rid, params).await {
            log(&app2, "error", format!("拆解失败：{e}"));
            emit_progress(&app2, &rid, "assemble", "failed", 0, Some(e));
        }
    });
    Ok(run_id)
}

#[tauri::command]
pub fn deconstruct_cancel(cancel: State<'_, DeconstructCancel>) {
    cancel.0.store(true, Ordering::SeqCst);
}

// ─────────────────────────── 流水线 ───────────────────────────

async fn run_pipeline(
    app: &AppHandle,
    client: &reqwest::Client,
    cancel: &Arc<AtomicBool>,
    run_id: &str,
    params: DeconstructParams,
) -> Result<(), String> {
    macro_rules! bail_if_cancelled {
        () => {
            if cancel.load(Ordering::SeqCst) {
                log(app, "info", "■ 已取消");
                emit_progress(app, run_id, "assemble", "cancelled", 0, Some("已取消".into()));
                return Ok(());
            }
        };
    }

    let run_dir = run_dir(app, run_id)?;
    let frames_dir = run_dir.join("frames");
    std::fs::create_dir_all(&frames_dir).map_err(|e| format!("创建工作目录失败：{e}"))?;

    let mut stages: Vec<StageState> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // ── C2 探测 ──
    emit_progress(app, run_id, "probe", "running", 0, None);
    bail_if_cancelled!();
    let source = probe_source(app, &params.input).await?;
    log(app, "info", format!("▶ 探测：{} · {:.1}s · {}×{} · {:.0}fps", source.filename, source.duration_sec, source.width, source.height, source.fps));
    emit_progress(app, run_id, "probe", "done", 100, None);
    stages.push(StageState { id: "probe".into(), status: "done".into(), error: None });

    // ── C5 分镜切分 ──
    emit_progress(app, run_id, "scene", "running", 0, None);
    bail_if_cancelled!();
    let cuts = detect_scene_cuts(app, &params.input, params.scene_threshold).await;
    let mut shots = build_shots(&cuts, source.duration_sec);
    log(app, "info", format!("▶ 分镜：{} 个镜头", shots.len()));
    emit_progress(app, run_id, "scene", "done", 100, None);
    stages.push(StageState { id: "scene".into(), status: "done".into(), error: None });

    // ── C6 关键帧抽取（均匀采样到 maxFrames）──
    emit_progress(app, run_id, "keyframe", "running", 0, None);
    bail_if_cancelled!();
    let sample_idx = sample_indices(shots.len(), params.max_frames);
    for (n, &i) in sample_idx.iter().enumerate() {
        bail_if_cancelled!();
        let mid = (shots[i].start + shots[i].end) / 2.0;
        let out = frames_dir.join(format!("shot_{:03}.jpg", i));
        if extract_keyframe(app, &params.input, mid, &out).await {
            shots[i].keyframe_path = Some(format!("frames/shot_{:03}.jpg", i));
        }
        let pct = ((n + 1) * 100 / sample_idx.len().max(1)) as u32;
        emit_progress(app, run_id, "keyframe", "running", pct, None);
    }
    emit_progress(app, run_id, "keyframe", "done", 100, None);
    stages.push(StageState { id: "keyframe".into(), status: "done".into(), error: None });

    // ── C7 节奏 ──
    emit_progress(app, run_id, "rhythm", "running", 0, None);
    let rhythm = compute_rhythm(&shots, source.duration_sec);
    emit_progress(app, run_id, "rhythm", "done", 100, None);
    stages.push(StageState { id: "rhythm".into(), status: "done".into(), error: None });

    // ── C3/C4 ASR：阶段 B 接 whisper.cpp，当前跳过 ──
    let transcript = Transcript {
        lang: "und".into(),
        full_text: String::new(),
        segments: Vec::new(),
    };
    emit_progress(app, run_id, "asr", "skipped", 100, Some("口播转写待 whisper 接入（阶段 B）".into()));
    stages.push(StageState { id: "asr".into(), status: "skipped".into(), error: None });
    if !source.has_audio {
        warnings.push("该视频无音轨。".into());
    }

    // 先落一份「本地半」报告，供外链模式 build/ingest 使用。
    let mut report = SkeletonReport {
        schema_version: SCHEMA_VERSION.into(),
        run_id: run_id.into(),
        generated_at: now_unix_string(),
        status: "partial".into(),
        source,
        transcript,
        shots,
        rhythm,
        hook: None,
        deconstruction: None,
        reusable_module: None,
        character_profile: None,
        emotion_order: Vec::new(),
        full_voiceover: String::new(),
        stages: stages.clone(),
        warnings: warnings.clone(),
        needs_weblink: false,
    };
    save_report(app, run_id, &report)?;

    // ── C8/C9/C10 智能半：经网关一次合并调用 ──
    emit_progress(app, run_id, "llm", "running", 0, None);
    bail_if_cancelled!();
    match run_llm(app, client, &report, params.hook_window_sec).await {
        Ok(parsed) => {
            apply_llm(&mut report, parsed);
            report.status = "completed".into();
            set_stage(&mut report.stages, "llm", "done", None);
            emit_progress(app, run_id, "llm", "done", 100, None);
        }
        Err(LlmReason::Weblink(msg)) => {
            report.needs_weblink = true;
            report.status = "partial".into();
            set_stage(&mut report.stages, "llm", "skipped", Some(msg.clone()));
            report.warnings.push(format!("智能半未走 API：{msg}（已切外链模式）"));
            emit_progress(app, run_id, "llm", "skipped", 100, Some(msg));
        }
        Err(LlmReason::Failed(msg)) => {
            report.status = "partial".into();
            set_stage(&mut report.stages, "llm", "failed", Some(msg.clone()));
            report.warnings.push(format!("智能半失败：{msg}（可重跑或走外链）"));
            emit_progress(app, run_id, "llm", "failed", 100, Some(msg));
        }
    }

    // ── C11 汇总落盘 ──
    save_report(app, run_id, &report)?;
    emit_progress(app, run_id, "assemble", "done", 100, None);
    log(app, "info", format!("✓ 完成：{run_id}（{}）", report.status));
    let _ = app.emit(DONE_EVENT, json!({ "runId": run_id, "report": &report }));
    Ok(())
}

// ─────────────────────────── LLM ───────────────────────────

enum LlmReason {
    Weblink(String),
    Failed(String),
}

/// 输出契约（单一事实来源）：API 提示词、外链提示词、ingest 解析三处共用同一套 JSON 键。
/// 改这里就同时改了三处，避免外链粘回解析失败。
fn output_contract() -> &'static str {
    "- hook: { visualHook, textHook, audioHook, score(0-100) }\n\
- deconstruction: { content, presentation, conversion }（爆款三层拆解：内容层/表现层/转化层）\n\
- reusableModule: string（一句话可复用模块公式）\n\
- characterProfile: { age, accent, voice, emphasis, visual }\n\
- emotionOrder: string[]（情绪顺序）\n\
- fullVoiceover: string（完整口播稿；逐字转写，若无人声则空字符串）\n\
- shotCaptions: string[]（按镜头先后顺序，每个镜头一句画面描述）"
}

/// 镜头时间线（参考），最多列前 30 个。
fn shot_timeline(report: &SkeletonReport) -> String {
    report
        .shots
        .iter()
        .take(30)
        .map(|s| format!("镜头{} [{:.1}-{:.1}s]", s.index, s.start, s.end))
        .collect::<Vec<_>>()
        .join("、")
}

/// API 模式提示词：附帧（+可能附音频）。
fn build_user_prompt(report: &SkeletonReport, hook_window_sec: f64) -> String {
    let audio_clause = if report.source.has_audio {
        "并附上该视频的音频，请据音频转写完整口播稿到 fullVoiceover。"
    } else {
        "（该视频无音轨，fullVoiceover 留空字符串。）"
    };
    format!(
        "这是一条短视频（时长 {:.1}s，{} 个镜头，前 {:.0}s 视为钩子区）。\
下方按顺序附上若干关键帧图片，对应镜头：{}。{}\n\n\
请只输出一个 JSON 对象，键为：\n{}\n不要输出 JSON 以外的任何解释文字。",
        report.source.duration_sec,
        report.rhythm.shot_count,
        hook_window_sec,
        shot_timeline(report),
        audio_clause,
        output_contract(),
    )
}

/// 外链模式提示词（公式化）：用户已把整段视频上传到 Gemini 网页，无附图。
fn build_external_prompt(report: &SkeletonReport) -> String {
    format!(
        "你是资深短视频带货拆解师。我已经把一条短视频上传给你（文件名「{}」，时长约 {:.1}s，约 {} 个镜头）。\
请你**完整观看并听完**这条视频，然后只输出一个 JSON 对象（不要任何解释、不要 Markdown 代码块以外的文字），键如下：\n{}\n\n\
参考：程序检测到的分镜时间线 = {}。shotCaptions 请按镜头先后顺序、与上面镜头数量一致。\n\
直接给我可被程序解析的纯 JSON。",
        report.source.filename,
        report.source.duration_sec,
        report.rhythm.shot_count,
        output_contract(),
        shot_timeline(report),
    )
}

async fn run_llm(
    app: &AppHandle,
    client: &reqwest::Client,
    report: &SkeletonReport,
    hook_window_sec: f64,
) -> Result<Value, LlmReason> {
    // 收集关键帧并编码
    let run_dir = run_dir(app, &report.run_id).map_err(LlmReason::Failed)?;
    let mut images = Vec::new();
    for s in report.shots.iter().filter(|s| s.keyframe_path.is_some()) {
        if let Some(rel) = &s.keyframe_path {
            let abs = run_dir.join(rel);
            if let Ok(img) = llm::encode_image_file(&abs.to_string_lossy()) {
                images.push(img);
            }
        }
    }

    // 有音轨则抽一条压缩音频随调用上传（仅支持音频的厂商如 Gemini 会用它转写口播稿）。
    let mut audios = Vec::new();
    if report.source.has_audio {
        if let Some(audio_path) = extract_audio(app, &report.source.path, &run_dir).await {
            // 体积护栏：Gemini inline 约 ≤20MB，超限则不内联（避免请求被拒）。
            let ok_size = std::fs::metadata(&audio_path).map(|m| m.len() < 18 * 1024 * 1024).unwrap_or(false);
            if ok_size {
                if let Ok(au) = llm::encode_audio_file(&audio_path.to_string_lossy()) {
                    audios.push(au);
                }
            }
        }
    }

    let req = AnalyzeRequest {
        system: "你是资深短视频拆解师，精通带货爆款结构。严格按要求只输出 JSON。".into(),
        user_text: build_user_prompt(report, hook_window_sec),
        images,
        audios,
        json_schema: Some(json!({ "type": "object" })),
        max_tokens: None,
    };

    match llm::analyze(app, client, "deconstructor.decon", req).await {
        Ok(resp) => resp
            .json
            .or_else(|| llm::adapters::extract_json(&resp.text))
            .ok_or_else(|| LlmReason::Failed("模型未返回合法 JSON".into())),
        Err(e) => match e {
            LlmError::Auth | LlmError::QuotaExhausted { .. } | LlmError::NotConfigured => {
                Err(LlmReason::Weblink(e.to_string()))
            }
            other => Err(LlmReason::Failed(other.to_string())),
        },
    }
}

/// 把 LLM/外链解析出的 JSON 合并进报告。
fn apply_llm(report: &mut SkeletonReport, v: Value) {
    report.hook = v.get("hook").cloned();
    report.deconstruction = v.get("deconstruction").cloned();
    report.reusable_module = v.get("reusableModule").and_then(|x| x.as_str()).map(|s| s.to_string());
    report.character_profile = v.get("characterProfile").cloned();
    if let Some(arr) = v.get("emotionOrder").and_then(|x| x.as_array()) {
        report.emotion_order = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
    }
    // 口播稿：与拆解同一次调用顺带产出（外链模式 Gemini 听整段视频；API 模式仅传帧时通常为空）
    if let Some(vo) = v.get("fullVoiceover").and_then(|x| x.as_str()) {
        let vo = vo.trim();
        if !vo.is_empty() {
            report.full_voiceover = vo.to_string();
            if report.transcript.full_text.trim().is_empty() {
                report.transcript.full_text = vo.to_string();
            }
        }
    }
    // shotCaptions 按"有关键帧的镜头"顺序回填
    if let Some(caps) = v.get("shotCaptions").and_then(|x| x.as_array()) {
        let idxs: Vec<usize> = report
            .shots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.keyframe_path.is_some())
            .map(|(i, _)| i)
            .collect();
        for (cap_i, &shot_i) in idxs.iter().enumerate() {
            if let Some(c) = caps.get(cap_i).and_then(|x| x.as_str()) {
                report.shots[shot_i].caption = Some(c.to_string());
            }
        }
    }
}

fn set_stage(stages: &mut [StageState], id: &str, status: &str, error: Option<String>) {
    if let Some(s) = stages.iter_mut().find(|s| s.id == id) {
        s.status = status.into();
        s.error = error;
    }
}

// ─────────────────────────── 外链模式 / 读写 / 导出 命令 ───────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPrompts {
    /// 公式化、可一键复制的完整提示词。
    pub prompt: String,
    /// 上传可行性提示（视频过长/过大时给出替代方案）。
    pub upload_hint: String,
    /// 关键帧目录（视频太长无法整段上传时，可改拖这些帧）。
    pub frames_dir: String,
    /// 一键打开的外链入口。
    pub gemini_url: String,
}

/// 视频上传可行性预检（Gemini 网页对时长/大小有限制）。
fn upload_hint(report: &SkeletonReport) -> String {
    let too_long = report.source.duration_sec > 180.0;
    let too_big = report.source.size_bytes > 100 * 1024 * 1024;
    if too_long || too_big {
        let mb = report.source.size_bytes as f64 / (1024.0 * 1024.0);
        format!(
            "⚠ 该视频较{}（{:.0}s / {:.0}MB），网页端可能无法直接上传。建议截取核心片段后再传，或改把下方关键帧目录里的图片拖进对话。",
            if too_long { "长" } else { "大" },
            report.source.duration_sec,
            mb,
        )
    } else {
        "✅ 可直接把该视频文件拖进 Gemini 网页对话框上传，再粘贴下方提示词。".into()
    }
}

/// 外链模式：生成可粘贴到 Gemini 网页的公式化提示词 + 上传预检。
#[tauri::command]
pub fn deconstruct_build_external(app: AppHandle, run_id: String) -> Result<ExternalPrompts, String> {
    let report = load_report(app.clone(), run_id.clone())?;
    let frames_dir = run_dir(&app, &run_id)?.join("frames").to_string_lossy().to_string();
    Ok(ExternalPrompts {
        prompt: build_external_prompt(&report),
        upload_hint: upload_hint(&report),
        frames_dir,
        gemini_url: "https://gemini.google.com/app".into(),
    })
}

/// 外链模式：解析用户从 Gemini 粘回的文本（JSON），合并进报告。
#[tauri::command]
pub fn deconstruct_ingest_external(
    app: AppHandle,
    run_id: String,
    pasted_text: String,
) -> Result<SkeletonReport, String> {
    let mut report = load_report(app.clone(), run_id.clone())?;
    let v = llm::adapters::extract_json(&pasted_text)
        .ok_or_else(|| "未能从粘贴内容中解析出 JSON，请确认已复制完整。".to_string())?;
    apply_llm(&mut report, v);
    report.needs_weblink = false;
    report.status = "completed".into();
    set_stage(&mut report.stages, "llm", "done", None);
    save_report(&app, &run_id, &report)?;
    Ok(report)
}

#[tauri::command]
pub fn deconstruct_load_report(app: AppHandle, run_id: String) -> Result<SkeletonReport, String> {
    load_report(app, run_id)
}

/// 导出报告：format = "json" | "md"，返回导出文件路径。
#[tauri::command]
pub fn deconstruct_export(app: AppHandle, run_id: String, format: String) -> Result<String, String> {
    let report = load_report(app.clone(), run_id.clone())?;
    let dir = run_dir(&app, &run_id)?;
    let path = match format.as_str() {
        "md" => {
            let p = dir.join("report.md");
            std::fs::write(&p, render_markdown(&report)).map_err(|e| format!("写出失败：{e}"))?;
            p
        }
        _ => dir.join("report.json"),
    };
    Ok(path.to_string_lossy().to_string())
}

fn render_markdown(r: &SkeletonReport) -> String {
    let mut s = String::new();
    s.push_str(&format!("# 拆解报告 · {}\n\n", r.source.filename));
    s.push_str(&format!("- 时长：{:.1}s ｜ {}×{} ｜ {:.0}fps ｜ 镜头 {}\n", r.source.duration_sec, r.source.width, r.source.height, r.source.fps, r.rhythm.shot_count));
    s.push_str(&format!("- 节奏：均长 {:.1}s ｜ 切换 {:.1}/min ｜ 最快 {:.1}s\n", r.rhythm.avg_shot_sec, r.rhythm.cuts_per_min, r.rhythm.fastest_shot_sec));
    if let Some(m) = &r.reusable_module {
        s.push_str(&format!("\n**可复用模块**：{m}\n"));
    }
    if !r.emotion_order.is_empty() {
        s.push_str(&format!("\n**情绪顺序**：{}\n", r.emotion_order.join(" → ")));
    }
    if !r.full_voiceover.trim().is_empty() {
        s.push_str(&format!("\n## 口播稿\n{}\n", r.full_voiceover));
    }
    if let Some(h) = &r.hook {
        s.push_str(&format!("\n## 钩子\n```json\n{}\n```\n", serde_json::to_string_pretty(h).unwrap_or_default()));
    }
    if let Some(d) = &r.deconstruction {
        s.push_str(&format!("\n## 三层拆解\n```json\n{}\n```\n", serde_json::to_string_pretty(d).unwrap_or_default()));
    }
    s.push_str("\n## 逐镜分镜\n");
    for shot in &r.shots {
        s.push_str(&format!("- 镜头{} [{:.1}-{:.1}s]：{}\n", shot.index, shot.start, shot.end, shot.caption.clone().unwrap_or_default()));
    }
    s
}

// ─────────────────────────── 文件 / ffmpeg 助手 ───────────────────────────

fn run_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("取应用数据目录失败：{e}"))?;
    Ok(base.join("deconstructor").join(run_id))
}

fn save_report(app: &AppHandle, run_id: &str, report: &SkeletonReport) -> Result<(), String> {
    let dir = run_dir(app, run_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let json = serde_json::to_string_pretty(report).map_err(|e| format!("序列化报告失败：{e}"))?;
    std::fs::write(dir.join("report.json"), json).map_err(|e| format!("写报告失败：{e}"))?;
    Ok(())
}

fn load_report(app: AppHandle, run_id: String) -> Result<SkeletonReport, String> {
    let dir = run_dir(&app, &run_id)?;
    let text = std::fs::read_to_string(dir.join("report.json")).map_err(|e| format!("读取报告失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析报告失败：{e}"))
}

async fn probe_source(app: &AppHandle, input: &str) -> Result<Source, String> {
    let duration = probe_one(app, input, None, "format=duration").await.and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let dims = probe_one(app, input, Some("v:0"), "stream=width,height").await;
    let (width, height) = parse_dims(dims.as_deref());
    let fps = probe_one(app, input, Some("v:0"), "stream=avg_frame_rate").await.and_then(|s| parse_rate(&s)).unwrap_or(0.0);
    let has_audio = probe_one(app, input, Some("a:0"), "stream=codec_name").await.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let size_bytes = std::fs::metadata(input).map(|m| m.len()).unwrap_or(0);
    let filename = PathBuf::from(input).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if duration <= 0.0 && width == 0 {
        return Err("无法读取视频元数据，请确认文件有效。".into());
    }
    Ok(Source { path: input.into(), filename, duration_sec: duration, width, height, fps, has_audio, size_bytes })
}

async fn probe_one(app: &AppHandle, path: &str, select: Option<&str>, entries: &str) -> Option<String> {
    let mut args: Vec<String> = vec!["-v".into(), "error".into()];
    if let Some(sel) = select {
        args.push("-select_streams".into());
        args.push(sel.into());
    }
    args.extend(["-show_entries".into(), entries.into(), "-of".into(), "default=nw=1:nk=1".into(), path.into()]);
    let cmd = app.shell().sidecar("ffprobe").ok()?.args(args);
    let output = cmd.output().await.ok()?;
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 用 ffmpeg scene 探测镜头切点，返回切换时间（秒）升序。
async fn detect_scene_cuts(app: &AppHandle, input: &str, threshold: f64) -> Vec<f64> {
    let vf = format!("select='gt(scene,{threshold})',showinfo");
    let cmd = match app.shell().sidecar("ffmpeg") {
        Ok(c) => c.args(["-hide_banner", "-i", input, "-vf", &vf, "-an", "-f", "null", "-"]),
        Err(_) => return Vec::new(),
    };
    let Ok(output) = cmd.output().await else {
        return Vec::new();
    };
    parse_scene_times(&String::from_utf8_lossy(&output.stderr))
}

fn parse_scene_times(stderr: &str) -> Vec<f64> {
    let mut times = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = stderr[from..].find("pts_time:") {
        let start = from + rel + "pts_time:".len();
        let rest = &stderr[start..];
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        if let Ok(t) = rest[..end].parse::<f64>() {
            times.push(t);
        }
        from = start;
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times
}

/// 由切点 + 总时长构造镜头序列。
fn build_shots(cuts: &[f64], duration: f64) -> Vec<Shot> {
    let mut bounds: Vec<f64> = vec![0.0];
    for &c in cuts {
        if c > 0.1 && c < duration - 0.1 {
            bounds.push(c);
        }
    }
    bounds.push(duration.max(0.0));
    bounds.dedup_by(|a, b| (*a - *b).abs() < 0.05);

    let mut shots = Vec::new();
    for w in bounds.windows(2) {
        let (start, end) = (w[0], w[1]);
        let dur = end - start;
        if dur < 0.1 {
            continue;
        }
        shots.push(Shot {
            index: shots.len(),
            start,
            end,
            duration_sec: dur,
            keyframe_path: None,
            caption: None,
        });
    }
    if shots.is_empty() && duration > 0.0 {
        shots.push(Shot { index: 0, start: 0.0, end: duration, duration_sec: duration, keyframe_path: None, caption: None });
    }
    shots
}

fn compute_rhythm(shots: &[Shot], duration: f64) -> Rhythm {
    let count = shots.len();
    let tempo: Vec<f64> = shots.iter().map(|s| (s.duration_sec * 10.0).round() / 10.0).collect();
    let avg = if count > 0 { shots.iter().map(|s| s.duration_sec).sum::<f64>() / count as f64 } else { 0.0 };
    let fastest = shots.iter().map(|s| s.duration_sec).fold(f64::INFINITY, f64::min);
    let cuts_per_min = if duration > 0.0 { (count.saturating_sub(1)) as f64 / duration * 60.0 } else { 0.0 };
    Rhythm {
        shot_count: count,
        avg_shot_sec: (avg * 10.0).round() / 10.0,
        cuts_per_min: (cuts_per_min * 10.0).round() / 10.0,
        fastest_shot_sec: if fastest.is_finite() { (fastest * 10.0).round() / 10.0 } else { 0.0 },
        tempo_curve: tempo,
    }
}

/// 从 n 个镜头里均匀取最多 k 个的下标。
fn sample_indices(n: usize, k: usize) -> Vec<usize> {
    if n == 0 || k == 0 {
        return Vec::new();
    }
    if n <= k {
        return (0..n).collect();
    }
    (0..k).map(|i| i * (n - 1) / (k - 1).max(1)).collect()
}

async fn extract_keyframe(app: &AppHandle, input: &str, at_sec: f64, out: &PathBuf) -> bool {
    let cmd = match app.shell().sidecar("ffmpeg") {
        Ok(c) => c.args([
            "-y",
            "-ss",
            &format!("{at_sec:.3}"),
            "-i",
            input,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            "-vf",
            "scale='min(768,iw)':-2",
            &out.to_string_lossy(),
        ]),
        Err(_) => return false,
    };
    matches!(cmd.output().await, Ok(o) if o.status.success()) && out.exists()
}

/// 抽取压缩音轨（mono / 16k / mp3）用于音频转写，体积小、足够语音识别。成功返回路径。
async fn extract_audio(app: &AppHandle, input: &str, run_dir: &PathBuf) -> Option<PathBuf> {
    let out = run_dir.join("audio.mp3");
    let cmd = app.shell().sidecar("ffmpeg").ok()?.args([
        "-y",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        &out.to_string_lossy(),
    ]);
    let ok = matches!(cmd.output().await, Ok(o) if o.status.success());
    if ok && out.exists() {
        Some(out)
    } else {
        None
    }
}

fn parse_dims(s: Option<&str>) -> (u32, u32) {
    let Some(s) = s else { return (0, 0) };
    let mut it = s.split_whitespace();
    let w = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let h = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (w, h)
}

fn parse_rate(s: &str) -> Option<f64> {
    let (a, b) = s.trim().split_once('/').unwrap_or((s.trim(), "1"));
    let a: f64 = a.parse().ok()?;
    let b: f64 = b.parse().ok()?;
    if b == 0.0 {
        None
    } else {
        Some(a / b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_times_parsed() {
        let s = "frame... pts_time:1.5 ...\nframe pts_time:3.25 end";
        assert_eq!(parse_scene_times(s), vec![1.5, 3.25]);
    }

    #[test]
    fn shots_from_cuts() {
        let shots = build_shots(&[3.0, 6.0], 9.0);
        assert_eq!(shots.len(), 3);
        assert_eq!(shots[0].index, 0);
        assert!((shots[2].end - 9.0).abs() < 1e-6);
    }

    #[test]
    fn shots_single_when_no_cuts() {
        let shots = build_shots(&[], 5.0);
        assert_eq!(shots.len(), 1);
        assert!((shots[0].duration_sec - 5.0).abs() < 1e-6);
    }

    #[test]
    fn sample_idx_even() {
        assert_eq!(sample_indices(10, 3), vec![0, 4, 9]);
        assert_eq!(sample_indices(2, 5), vec![0, 1]);
        assert_eq!(sample_indices(0, 5), Vec::<usize>::new());
    }

    #[test]
    fn rhythm_basic() {
        let shots = build_shots(&[2.0, 4.0], 6.0);
        let r = compute_rhythm(&shots, 6.0);
        assert_eq!(r.shot_count, 3);
        assert_eq!(r.tempo_curve.len(), 3);
    }
}
