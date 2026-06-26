import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

export type VideoCodec = "h264" | "h265";

export interface TranscodeParams {
  inputs: string[];
  outputDir: string | null;
  suffix: string;
  codec: VideoCodec;
  crf: number;
  preset: string;
  audioBitrate: number;
  smartCrop: boolean;
  limit1080p: boolean;
  keepFps: boolean;
  fps: number;
  concurrency: number;
}

export type JobStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface TranscodeProgress {
  file: string;
  status: JobStatus;
  percent: number;
  outputPath?: string | null;
  message?: string | null;
}

const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "ts"];

/** 选择视频文件（可多选） */
export async function pickVideoFiles(): Promise<string[]> {
  const res = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "视频", extensions: VIDEO_EXTS }],
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/** 选择文件夹（其中的视频会被后端递归收集） */
export async function pickFolder(): Promise<string | null> {
  const res = await open({ multiple: false, directory: true });
  return (res as string) ?? null;
}

/** 选择输出目录 */
export async function pickOutputDir(): Promise<string | null> {
  const res = await open({ multiple: false, directory: true });
  return (res as string) ?? null;
}

/** 让后端把文件夹里的视频路径列出来 */
export function listVideosInFolder(folder: string): Promise<string[]> {
  return invoke<string[]>("list_videos_in_folder", { folder });
}

/** 启动批量转码 */
export function startTranscode(params: TranscodeParams): Promise<void> {
  return invoke("transcode_batch", { params });
}

/** 取消正在进行的批量转码 */
export function cancelTranscode(): Promise<void> {
  return invoke("cancel_transcode");
}

/** 订阅转码进度事件 */
export function onTranscodeProgress(
  cb: (p: TranscodeProgress) => void,
): Promise<UnlistenFn> {
  return listen<TranscodeProgress>("transcode://progress", (e) => cb(e.payload));
}

export type LogLevel = "info" | "error";

export interface LogLine {
  level: LogLevel;
  message: string;
}

/** 订阅后端运行日志（推送到 UI 日志面板） */
export function onTranscodeLog(
  cb: (line: LogLine) => void,
): Promise<UnlistenFn> {
  return listen<LogLine>("transcode://log", (e) => cb(e.payload));
}

export type VerifyStatus = "ok" | "warn" | "fail";

export interface VerifyItem {
  key: string;
  label: string;
  status: VerifyStatus;
  expected: string;
  actual: string;
}

export interface VerifyReport {
  file: string;
  outputPath: string;
  overall: VerifyStatus;
  items: VerifyItem[];
}

/** 订阅「处理后验证」报告 */
export function onTranscodeVerify(
  cb: (report: VerifyReport) => void,
): Promise<UnlistenFn> {
  return listen<VerifyReport>("transcode://verify", (e) => cb(e.payload));
}

/** 在系统文件管理器中打开目录 */
export function openInExplorer(path: string): Promise<void> {
  return openPath(path);
}

/** 在文件管理器中定位并选中某个文件（打开其所在目录） */
export function revealItem(path: string): Promise<void> {
  return revealItemInDir(path);
}
