import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

export interface TranscodeParams {
  inputs: string[];
  outputDir: string | null;
  suffix: string;
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  audioBitrate: number;
  concurrency: number;
}

export type JobStatus = "pending" | "running" | "done" | "error";

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

/** 订阅转码进度事件 */
export function onTranscodeProgress(
  cb: (p: TranscodeProgress) => void,
): Promise<UnlistenFn> {
  return listen<TranscodeProgress>("transcode://progress", (e) => cb(e.payload));
}

/** 在系统文件管理器中打开目录 */
export function openInExplorer(path: string): Promise<void> {
  return openPath(path);
}
