import { useState } from "react";
import {
  addConnection,
  deleteConnection,
  testConnection,
  updateConnection,
  FORMAT_PRESETS,
  STATUS_LABEL,
  type Connection,
  type KeyStatus,
  type LlmConfig,
  type LlmFormat,
} from "../../lib/llm";

const STATUS_COLOR: Record<KeyStatus, string> = {
  unknown: "var(--ck-text-dim)",
  valid: "#34d399",
  invalid: "#f87171",
  quota_exhausted: "#fbbf24",
};

export default function ConnectionManager({
  config,
  onChange,
}: {
  config: LlmConfig;
  onChange: (c: LlmConfig) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function onTest(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      const r = await testConnection(id);
      onChange(await refresh());
      if (r.status !== "valid") setErr(r.message ?? `状态：${STATUS_LABEL[r.status]}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function refresh(): Promise<LlmConfig> {
    const { getLlmConfig } = await import("../../lib/llm");
    return getLlmConfig();
  }

  async function onToggleEnabled(c: Connection) {
    const next = await updateConnection({ id: c.id, enabled: !c.enabled });
    onChange(next);
  }

  async function onDelete(id: string) {
    const next = await deleteConnection(id);
    onChange(next);
  }

  async function onSaveKey(id: string) {
    if (!keyDraft.trim()) return;
    const next = await updateConnection({ id, key: keyDraft.trim() });
    onChange(next);
    setEditKeyId(null);
    setKeyDraft("");
    onTest(id);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">模型厂商连接</h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="rounded-md px-3 py-1.5 text-xs font-medium transition active:scale-[0.97]"
          style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}
        >
          {adding ? "取消" : "+ 添加连接"}
        </button>
      </div>

      {err && (
        <div className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.12)", color: "#f87171" }}>
          {err}
        </div>
      )}

      {adding && <AddForm onDone={(c) => { onChange(c); setAdding(false); }} />}

      <div className="mt-3 space-y-2">
        {config.connections.length === 0 && !adding && (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs" style={{ borderColor: "var(--ck-border)", color: "var(--ck-text-dim)" }}>
            还没有连接。点「添加连接」，推荐先加一个 Gemini 免费 key。
          </p>
        )}

        {config.connections.map((c) => {
          const k = c.keys[0];
          return (
            <div
              key={c.id}
              className="rounded-lg border p-3"
              style={{ background: "var(--ck-surface-2)", borderColor: "var(--ck-border)", opacity: c.enabled ? 1 : 0.55 }}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{c.label || "(未命名)"}</span>
                <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--ck-bg)", color: "var(--ck-text-dim)" }}>
                  {FORMAT_PRESETS[c.format].label}
                </span>
                {k && (
                  <span className="flex items-center gap-1 text-[11px]" style={{ color: STATUS_COLOR[k.status] }}>
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k.status] }} />
                    {STATUS_LABEL[k.status]}
                  </span>
                )}
                <span className="ml-auto text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
                  {c.models.length} 个模型
                </span>
              </div>

              <div className="mt-1 truncate text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
                {c.baseUrl} · key {k?.keyMasked || "—"}
              </div>

              {editKeyId === c.id ? (
                <div className="mt-2 flex gap-2">
                  <input
                    autoFocus
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="粘贴新的 API key"
                    className="flex-1 rounded-md border px-2 py-1 text-xs outline-none"
                    style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }}
                  />
                  <SmallBtn onClick={() => onSaveKey(c.id)} primary>保存</SmallBtn>
                  <SmallBtn onClick={() => { setEditKeyId(null); setKeyDraft(""); }}>取消</SmallBtn>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <SmallBtn onClick={() => onTest(c.id)} disabled={busyId === c.id}>
                    {busyId === c.id ? "测试中…" : "测试"}
                  </SmallBtn>
                  <SmallBtn onClick={() => { setEditKeyId(c.id); setKeyDraft(""); }}>换 key</SmallBtn>
                  <SmallBtn onClick={() => onToggleEnabled(c)}>{c.enabled ? "停用" : "启用"}</SmallBtn>
                  <SmallBtn onClick={() => onDelete(c.id)} danger>删除</SmallBtn>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddForm({ onDone }: { onDone: (c: LlmConfig) => void }) {
  const [format, setFormat] = useState<LlmFormat>("gemini");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState(FORMAT_PRESETS.gemini.baseUrl);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const preset = FORMAT_PRESETS[format];

  function onPickFormat(f: LlmFormat) {
    setFormat(f);
    setBaseUrl(FORMAT_PRESETS[f].baseUrl);
  }

  async function submit() {
    if (!key.trim()) { setErr("请填写 API key"); return; }
    setBusy(true);
    setErr(null);
    try {
      const cfg = await addConnection({
        label: label.trim() || preset.label,
        format,
        baseUrl: baseUrl.trim(),
        key: key.trim(),
      });
      // 添加后自动测试最后一个连接
      const last = cfg.connections[cfg.connections.length - 1];
      if (last) { try { await testConnection(last.id); } catch { /* 忽略 */ } }
      const { getLlmConfig } = await import("../../lib/llm");
      onDone(await getLlmConfig());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ background: "var(--ck-surface-2)", borderColor: "var(--ck-border)" }}>
      <div className="flex gap-2">
        {(["gemini", "openai"] as LlmFormat[]).map((f) => (
          <button
            key={f}
            onClick={() => onPickFormat(f)}
            className="rounded-md px-3 py-1.5 text-xs font-medium transition active:scale-[0.97]"
            style={{
              background: format === f ? "var(--ck-accent)" : "var(--ck-bg)",
              color: format === f ? "#06231f" : "var(--ck-text-dim)",
            }}
          >
            {FORMAT_PRESETS[f].label}
          </button>
        ))}
      </div>

      <p className="mt-2 text-[11px]" style={{ color: "var(--ck-text-dim)" }}>{preset.keyHint}</p>

      <div className="mt-2 grid gap-2">
        <Field label="名称（可选）">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset.label}
            className="w-full rounded-md border px-2 py-1.5 text-xs outline-none"
            style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }} />
        </Field>
        <Field label="Base URL">
          <input value={baseUrl} disabled={!preset.baseUrlEditable} onChange={(e) => setBaseUrl(e.target.value)}
            className="w-full rounded-md border px-2 py-1.5 text-xs outline-none disabled:opacity-60"
            style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }} />
        </Field>
        <Field label="API key">
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴 key"
            className="w-full rounded-md border px-2 py-1.5 text-xs outline-none"
            style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }} />
        </Field>
      </div>

      {err && <p className="mt-2 text-[11px]" style={{ color: "#f87171" }}>{err}</p>}

      <button onClick={submit} disabled={busy}
        className="mt-3 rounded-md px-4 py-1.5 text-xs font-medium transition active:scale-[0.97] disabled:opacity-60"
        style={{ background: "var(--ck-accent)", color: "#06231f" }}>
        {busy ? "添加并测试中…" : "添加并测试"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px]" style={{ color: "var(--ck-text-dim)" }}>{label}</span>
      {children}
    </label>
  );
}

function SmallBtn({
  children, onClick, primary, danger, disabled,
}: {
  children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97] disabled:opacity-50"
      style={{
        background: primary ? "var(--ck-accent)" : "var(--ck-bg)",
        color: primary ? "#06231f" : danger ? "#f87171" : "var(--ck-text)",
        border: "1px solid var(--ck-border)",
      }}>
      {children}
    </button>
  );
}
