import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* 对标拆解器（P1·阶段A）前端封装。组件只调这里，不直接 invoke。 */

export interface DeconstructParams {
  input: string;
  hookWindowSec?: number;
  sceneThreshold?: number;
  maxFrames?: number;
}

export interface Source {
  path: string;
  filename: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sizeBytes: number;
}

export interface Shot {
  index: number;
  start: number;
  end: number;
  durationSec: number;
  keyframePath?: string | null;
  caption?: string | null;
}

export interface Rhythm {
  shotCount: number;
  avgShotSec: number;
  cutsPerMin: number;
  fastestShotSec: number;
  tempoCurve: number[];
}

export interface StageState {
  id: string;
  status: string;
  error?: string | null;
}

export interface SkeletonReport {
  schemaVersion: string;
  runId: string;
  generatedAt: string;
  status: string;
  source: Source;
  transcript: { lang: string; fullText: string; segments: unknown[] };
  shots: Shot[];
  rhythm: Rhythm;
  hook: unknown | null;
  deconstruction: unknown | null;
  reusableModule?: string | null;
  characterProfile: unknown | null;
  emotionOrder: string[];
  fullVoiceover: string;
  stages: StageState[];
  warnings: string[];
  needsWeblink: boolean;
}

export interface ProgressPayload {
  runId: string;
  stageId: string;
  status: string; // pending|running|done|failed|skipped|cancelled
  percent: number;
  message?: string | null;
}

export interface ExternalPrompts {
  prompt: string;
  uploadHint: string;
  framesDir: string;
  geminiUrl: string;
}

export function deconstructStart(params: DeconstructParams): Promise<string> {
  return invoke<string>("deconstruct_start", { params });
}

export function deconstructCancel(): Promise<void> {
  return invoke("deconstruct_cancel");
}

export function buildExternalPrompts(runId: string): Promise<ExternalPrompts> {
  return invoke<ExternalPrompts>("deconstruct_build_external", { runId });
}

export function ingestExternalResult(runId: string, pastedText: string): Promise<SkeletonReport> {
  return invoke<SkeletonReport>("deconstruct_ingest_external", { runId, pastedText });
}

export function loadReport(runId: string): Promise<SkeletonReport> {
  return invoke<SkeletonReport>("deconstruct_load_report", { runId });
}

export function exportReport(runId: string, format: "json" | "md"): Promise<string> {
  return invoke<string>("deconstruct_export", { runId, format });
}

export function onProgress(cb: (p: ProgressPayload) => void): Promise<UnlistenFn> {
  return listen<ProgressPayload>("deconstruct://progress", (e) => cb(e.payload));
}

export function onDone(cb: (runId: string, report: SkeletonReport) => void): Promise<UnlistenFn> {
  return listen<{ runId: string; report: SkeletonReport }>("deconstruct://done", (e) =>
    cb(e.payload.runId, e.payload.report),
  );
}

/** 流水线阶段顺序与中文名（驱动 Stepper）。 */
export const STAGES: { id: string; label: string }[] = [
  { id: "probe", label: "读取信息" },
  { id: "scene", label: "分镜切分" },
  { id: "keyframe", label: "关键帧" },
  { id: "rhythm", label: "节奏分析" },
  { id: "asr", label: "口播转写" },
  { id: "llm", label: "智能拆解" },
  { id: "assemble", label: "汇总" },
];
