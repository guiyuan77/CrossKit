import { invoke } from "@tauri-apps/api/core";

/*
  LLM 网关的前端封装（专管 AI，与 ipc.ts 分离）。
  约定：组件只调这里的函数，不直接 invoke；明文 key 永不出后端，这里只见掩码。
  详见 docs/features/00-设置页与Key管理/DESIGN.md。
*/

export type LlmFormat = "openai" | "gemini";
export type LlmMode = "auto" | "api" | "weblink";
export type KeyStatus = "unknown" | "valid" | "invalid" | "quota_exhausted";

export interface ConnectionKey {
  id: string;
  keyMasked: string;
  status: KeyStatus;
  lastCheckedAt?: string | null;
  quotaResetAt?: string | null;
}

export interface Connection {
  id: string;
  label: string;
  format: LlmFormat;
  baseUrl: string;
  keys: ConnectionKey[];
  models: string[];
  enabled: boolean;
}

export interface ModelRef {
  connId: string;
  model: string;
}

export interface Assignments {
  global?: ModelRef | null;
  overrides: Record<string, ModelRef>;
}

export interface LlmConfig {
  mode: LlmMode;
  connections: Connection[];
  assignments: Assignments;
}

export interface LlmTask {
  id: string;
  moduleId: string;
  moduleLabel: string;
  label: string;
  needsVision: boolean;
}

export interface TestResult {
  status: KeyStatus;
  models: string[];
  quotaResetAt?: string | null;
  message?: string | null;
}

export interface StatusInfo {
  connected: boolean;
  activeModel?: string | null;
  mode: LlmMode;
}

export function getLlmConfig(): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_list_config");
}

export function listLlmTasks(): Promise<LlmTask[]> {
  return invoke<LlmTask[]>("llm_list_tasks");
}

export function setLlmMode(mode: LlmMode): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_set_mode", { mode });
}

/** scope = "global" | moduleId | taskId；modelRef=null 表示清除（回退上级）。 */
export function setLlmAssignment(
  scope: string,
  modelRef: ModelRef | null,
): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_set_assignment", { scope, modelRef });
}

export function addConnection(args: {
  label: string;
  format: LlmFormat;
  baseUrl: string;
  key: string;
}): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_add_connection", args);
}

export function updateConnection(args: {
  id: string;
  label?: string;
  baseUrl?: string;
  models?: string[];
  enabled?: boolean;
  key?: string;
}): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_update_connection", args);
}

export function deleteConnection(id: string): Promise<LlmConfig> {
  return invoke<LlmConfig>("llm_delete_connection", { id });
}

export function testConnection(id: string): Promise<TestResult> {
  return invoke<TestResult>("llm_test_connection", { id });
}

export function fetchModels(id: string): Promise<string[]> {
  return invoke<string[]>("llm_fetch_models", { id });
}

export function getLlmStatus(): Promise<StatusInfo> {
  return invoke<StatusInfo>("llm_status");
}

// ───────── 前端展示辅助 ─────────

export const STATUS_LABEL: Record<KeyStatus, string> = {
  unknown: "未校验",
  valid: "有效",
  invalid: "无效",
  quota_exhausted: "额度耗尽",
};

/** 厂商格式预设（添加连接时用）。 */
export const FORMAT_PRESETS: Record<
  LlmFormat,
  { label: string; baseUrl: string; baseUrlEditable: boolean; defaultModels: string[]; keyHint: string }
> = {
  gemini: {
    label: "Gemini 原生",
    baseUrl: "https://generativelanguage.googleapis.com",
    baseUrlEditable: false,
    defaultModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    keyHint: "AI Studio 免费申请的 AIza... 开头的 key",
  },
  openai: {
    label: "OpenAI 兼容",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: true,
    defaultModels: [],
    keyHint: "OpenAI / OpenRouter / DeepSeek / 本地 LM Studio 等的 key",
  },
};
