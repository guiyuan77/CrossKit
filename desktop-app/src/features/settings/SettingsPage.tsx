import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import {
  getLlmConfig,
  listLlmTasks,
  setLlmMode,
  type LlmConfig,
  type LlmMode,
  type LlmTask,
} from "../../lib/llm";
import ConnectionManager from "./ConnectionManager";
import ModelAssignmentTable from "./ModelAssignmentTable";

const MODES: { value: LlmMode; label: string; desc: string }[] = [
  { value: "auto", label: "自动", desc: "优先用 API，无可用 key 时各功能自动降级到外链" },
  { value: "api", label: "仅 API", desc: "只走 API，没 key 就报错（不外链）" },
  { value: "weblink", label: "仅外链", desc: "不调 API，所有 AI 步骤走网页手动粘贴" },
];

export default function SettingsPage() {
  const [defaultSuffix, setDefaultSuffix] = useState("_1080p");
  const [saved, setSaved] = useState(false);

  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [tasks, setTasks] = useState<LlmTask[]>([]);

  useEffect(() => {
    load("settings.json").then(async (store) => {
      const v = await store.get<string>("defaultSuffix");
      if (v) setDefaultSuffix(v);
    });
    getLlmConfig().then(setConfig).catch(() => {});
    listLlmTasks().then(setTasks).catch(() => {});
  }, []);

  async function onSave() {
    const store = await load("settings.json");
    await store.set("defaultSuffix", defaultSuffix);
    await store.save();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function onPickMode(m: LlmMode) {
    setConfig(await setLlmMode(m));
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <h1 className="text-xl font-semibold">设置</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
        全局偏好设置，保存在本地配置文件中。
      </p>

      {/* AI 模型接入（LLM 网关 · P0） */}
      <section
        className="mt-6 rounded-xl border p-6"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <h2 className="text-base font-semibold">AI 模型接入</h2>
        <p className="mt-1 text-xs" style={{ color: "var(--ck-text-dim)" }}>
          统一管理模型厂商连接，并为各功能/任务指派模型。API key 仅存本地、不会上传。
        </p>

        {/* 模式 */}
        <div className="mt-4 flex flex-wrap gap-2">
          {MODES.map((m) => {
            const active = config?.mode === m.value;
            return (
              <button
                key={m.value}
                onClick={() => onPickMode(m.value)}
                title={m.desc}
                className="rounded-lg px-3 py-1.5 text-xs font-medium transition active:scale-[0.97]"
                style={{
                  background: active ? "var(--ck-accent)" : "var(--ck-surface-2)",
                  color: active ? "#06231f" : "var(--ck-text-dim)",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
          {MODES.find((m) => m.value === config?.mode)?.desc}
        </p>

        {config ? (
          <>
            <div className="mt-5">
              <ConnectionManager config={config} onChange={setConfig} />
            </div>
            <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--ck-border)" }}>
              <ModelAssignmentTable config={config} tasks={tasks} onChange={setConfig} />
            </div>
          </>
        ) : (
          <p className="mt-4 text-xs" style={{ color: "var(--ck-text-dim)" }}>加载中…</p>
        )}
      </section>

      {/* 通用偏好 */}
      <section
        className="mt-6 rounded-xl border p-6"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <h2 className="text-base font-semibold">通用</h2>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs" style={{ color: "var(--ck-text-dim)" }}>
            默认文件名后缀
          </span>
          <input
            value={defaultSuffix}
            onChange={(e) => setDefaultSuffix(e.target.value)}
            className="w-full max-w-xs rounded-md border px-3 py-2 text-sm outline-none"
            style={{
              background: "var(--ck-surface-2)",
              borderColor: "var(--ck-border)",
              color: "var(--ck-text)",
            }}
          />
        </label>
        <button
          onClick={onSave}
          className="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition active:scale-[0.97]"
          style={{ background: "var(--ck-accent)", color: "#06231f" }}
        >
          {saved ? "已保存" : "保存"}
        </button>
      </section>
    </div>
  );
}
