import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  STAGES,
  buildExternalPrompts,
  deconstructCancel,
  deconstructStart,
  exportReport,
  ingestExternalResult,
  onDone,
  onProgress,
  type ProgressPayload,
  type SkeletonReport,
} from "../../lib/deconstructor";

type Phase = "import" | "running" | "result";
type StageInfo = { status: string; percent: number; message?: string | null };

const STAGE_ICON: Record<string, string> = {
  done: "✓",
  running: "⏳",
  pending: "○",
  failed: "⚠",
  skipped: "⊘",
  cancelled: "■",
};
const STAGE_COLOR: Record<string, string> = {
  done: "#34d399",
  running: "var(--ck-accent)",
  pending: "var(--ck-text-dim)",
  failed: "#f87171",
  skipped: "var(--ck-text-dim)",
  cancelled: "#fbbf24",
};

export default function DeconstructorPage() {
  const [phase, setPhase] = useState<Phase>("import");
  const [path, setPath] = useState<string | null>(null);
  const [hookWindowSec, setHookWindowSec] = useState(3);
  const [sceneThreshold, setSceneThreshold] = useState(0.3);
  const [maxFrames, setMaxFrames] = useState(12);

  const [runId, setRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [stages, setStages] = useState<Record<string, StageInfo>>({});
  const [report, setReport] = useState<SkeletonReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const offs: Array<() => void> = [];
    onProgress((p: ProgressPayload) => {
      if (p.runId !== runIdRef.current) return;
      setStages((prev) => ({ ...prev, [p.stageId]: { status: p.status, percent: p.percent, message: p.message } }));
    }).then((un) => offs.push(un));
    onDone((rid, rep) => {
      if (rid !== runIdRef.current) return;
      setReport(rep);
      setPhase("result");
    }).then((un) => offs.push(un));
    return () => offs.forEach((f) => f());
  }, []);

  async function pick() {
    const sel = await open({
      multiple: false,
      filters: [{ name: "视频", extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi"] }],
    });
    if (typeof sel === "string") {
      setPath(sel);
      setErr(null);
    }
  }

  async function start() {
    if (!path) return;
    setErr(null);
    setReport(null);
    const init: Record<string, StageInfo> = {};
    STAGES.forEach((s) => (init[s.id] = { status: "pending", percent: 0 }));
    setStages(init);
    setPhase("running");
    try {
      const rid = await deconstructStart({ input: path, hookWindowSec, sceneThreshold, maxFrames });
      runIdRef.current = rid;
      setRunId(rid);
    } catch (e) {
      setErr(String(e));
      setPhase("import");
    }
  }

  async function cancel() {
    await deconstructCancel().catch(() => {});
  }

  function reset() {
    setPhase("import");
    setReport(null);
    setRunId(null);
    runIdRef.current = null;
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">对标拆解器</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
            导入一条爆款，自动产出可复刻的结构骨架报告（钩子 / 分镜 / 节奏 / 三层拆解）。
          </p>
        </div>
        {phase === "result" && (
          <button onClick={reset} className="rounded-lg px-3 py-1.5 text-xs transition active:scale-[0.97]"
            style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>
            再拆一条
          </button>
        )}
      </div>

      <div className="mt-3 rounded-lg px-4 py-2.5 text-xs" style={{ background: "rgba(63,182,168,0.10)", color: "var(--ck-accent)" }}>
        阶段 A：本地链（探测/分镜/关键帧/节奏）+ 智能拆解（有 key 走网关，无 key 自动外链）。口播转写（whisper）将于阶段 B 接入。
      </div>

      {err && (
        <div className="mt-3 rounded-md px-3 py-2 text-xs" style={{ background: "rgba(248,113,113,0.12)", color: "#f87171" }}>
          {err}
        </div>
      )}

      {phase === "import" && (
        <ImportView
          path={path}
          hookWindowSec={hookWindowSec} setHookWindowSec={setHookWindowSec}
          sceneThreshold={sceneThreshold} setSceneThreshold={setSceneThreshold}
          maxFrames={maxFrames} setMaxFrames={setMaxFrames}
          onPick={pick} onStart={start}
        />
      )}

      {phase === "running" && <RunningView stages={stages} onCancel={cancel} />}

      {phase === "result" && report && (
        <ResultView report={report} runId={runId!} onReport={setReport} />
      )}
    </div>
  );
}

// ─────────────────────────── 导入态 ───────────────────────────

function ImportView(props: {
  path: string | null;
  hookWindowSec: number; setHookWindowSec: (n: number) => void;
  sceneThreshold: number; setSceneThreshold: (n: number) => void;
  maxFrames: number; setMaxFrames: (n: number) => void;
  onPick: () => void; onStart: () => void;
}) {
  return (
    <section className="mt-6 rounded-xl border p-6" style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}>
      <button onClick={props.onPick}
        className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed py-10 transition active:scale-[0.99]"
        style={{ borderColor: "var(--ck-border)", color: "var(--ck-text-dim)" }}>
        <span className="text-2xl">⬆</span>
        <span className="mt-2 text-sm">{props.path ? "重新选择视频" : "点击选择对标视频"}</span>
        <span className="mt-1 text-xs">单条，建议 ≤60s</span>
      </button>

      {props.path && (
        <div className="mt-2 truncate text-xs" style={{ color: "var(--ck-text-dim)" }} title={props.path}>
          {props.path}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        <NumField label="钩子窗口(s)" value={props.hookWindowSec} step={1} min={1} onChange={props.setHookWindowSec} />
        <NumField label="分镜灵敏度" value={props.sceneThreshold} step={0.05} min={0.05} onChange={props.setSceneThreshold} />
        <NumField label="关键帧上限" value={props.maxFrames} step={1} min={1} onChange={props.setMaxFrames} />
      </div>

      <button onClick={props.onStart} disabled={!props.path}
        className="mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50"
        style={{ background: "var(--ck-accent)", color: "#06231f" }}>
        开始拆解
      </button>
    </section>
  );
}

function NumField({ label, value, step, min, onChange }: { label: string; value: number; step: number; min: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px]" style={{ color: "var(--ck-text-dim)" }}>{label}</span>
      <input type="number" value={value} step={step} min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border px-2 py-1.5 text-sm outline-none"
        style={{ background: "var(--ck-surface-2)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }} />
    </label>
  );
}

// ─────────────────────────── 进行态 ───────────────────────────

function RunningView({ stages, onCancel }: { stages: Record<string, StageInfo>; onCancel: () => void }) {
  return (
    <section className="mt-6 rounded-xl border p-6" style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">正在拆解…</h2>
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs transition active:scale-[0.97]"
          style={{ background: "rgba(248,113,113,0.15)", color: "#f87171" }}>■ 停止</button>
      </div>
      <div className="mt-4 space-y-2">
        {STAGES.map((s) => {
          const info = stages[s.id] ?? { status: "pending", percent: 0 };
          const color = STAGE_COLOR[info.status] ?? "var(--ck-text-dim)";
          return (
            <div key={s.id} className="flex items-center gap-3">
              <span className="w-5 text-center" style={{ color }}>{STAGE_ICON[info.status] ?? "○"}</span>
              <span className="w-24 text-sm">{s.label}</span>
              {info.status === "running" && (
                <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--ck-surface-2)" }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${info.percent}%`, background: "var(--ck-accent)" }} />
                </div>
              )}
              <span className="ml-auto text-xs" style={{ color }}>
                {info.message ?? (info.status === "running" ? `${info.percent}%` : info.status)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────── 结果态 ───────────────────────────

type Tab = "overview" | "shots" | "decon" | "voice" | "raw";

function ResultView({ report, runId, onReport }: { report: SkeletonReport; runId: string; onReport: (r: SkeletonReport) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [exported, setExported] = useState<string | null>(null);

  async function doExport(format: "json" | "md") {
    const p = await exportReport(runId, format);
    setExported(p);
    setTimeout(() => setExported(null), 4000);
  }

  const s = report.source;
  const hook = report.hook as Record<string, unknown> | null;

  return (
    <section className="mt-6 rounded-xl border" style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3" style={{ borderColor: "var(--ck-border)" }}>
        <span className="text-sm font-medium">{s.filename}</span>
        <span className="text-xs" style={{ color: "var(--ck-text-dim)" }}>
          {s.durationSec.toFixed(1)}s · {s.width}×{s.height} · {report.rhythm.shotCount}镜头 · {report.status}
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => doExport("md")} className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97]"
            style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>导出 MD</button>
          <button onClick={() => doExport("json")} className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97]"
            style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>导出 JSON</button>
        </div>
      </div>

      {exported && (
        <div className="px-5 pt-2 text-[11px]" style={{ color: "var(--ck-accent)" }}>已导出：{exported}</div>
      )}

      <div className="flex gap-1 px-5 pt-3">
        {([["overview", "概览"], ["shots", "逐镜分镜"], ["decon", "三层拆解"], ["voice", "口播&画像"], ["raw", "原始JSON"]] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className="rounded-t-md px-3 py-1.5 text-xs transition"
            style={{ background: tab === id ? "var(--ck-surface-2)" : "transparent", color: tab === id ? "var(--ck-text)" : "var(--ck-text-dim)" }}>
            {label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {report.needsWeblink && <ExternalPanel runId={runId} onReport={onReport} />}

        {tab === "overview" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="钩子强度" value={hook && typeof hook.score === "number" ? `${hook.score}/100` : "—"} />
              <Stat label="镜头数" value={String(report.rhythm.shotCount)} />
              <Stat label="平均镜长" value={`${report.rhythm.avgShotSec}s`} />
              <Stat label="切换频率" value={`${report.rhythm.cutsPerMin}/min`} />
            </div>

            <TempoBar curve={report.rhythm.tempoCurve} />

            {hook && (
              <Card title="钩子（前3秒）">
                <KV k="视觉" v={hook.visualHook} />
                <KV k="文案" v={hook.textHook} />
                <KV k="声音" v={hook.audioHook} />
              </Card>
            )}

            {report.reusableModule && (
              <Card title="可复用模块"><p className="text-sm">{report.reusableModule}</p></Card>
            )}

            {report.emotionOrder.length > 0 && (
              <Card title="情绪顺序">
                <div className="flex flex-wrap gap-1.5">
                  {report.emotionOrder.map((e, i) => (
                    <span key={i} className="rounded px-2 py-0.5 text-xs" style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>{e}</span>
                  ))}
                </div>
              </Card>
            )}

            {report.warnings.length > 0 && (
              <div className="rounded-md px-3 py-2 text-xs" style={{ background: "rgba(251,191,36,0.10)", color: "#d9a441" }}>
                {report.warnings.map((w, i) => <div key={i}>· {w}</div>)}
              </div>
            )}
          </div>
        )}

        {tab === "shots" && (
          <div className="space-y-2">
            {report.shots.map((shot) => (
              <div key={shot.index} className="flex gap-3 rounded-lg border p-3" style={{ borderColor: "var(--ck-border)" }}>
                <div className="shrink-0 text-xs" style={{ color: "var(--ck-text-dim)" }}>
                  #{shot.index}<br />{shot.start.toFixed(1)}–{shot.end.toFixed(1)}s<br />({shot.durationSec.toFixed(1)}s)
                </div>
                <div className="text-sm">{shot.caption ?? <span style={{ color: "var(--ck-text-dim)" }}>（无画面描述）</span>}</div>
              </div>
            ))}
          </div>
        )}

        {tab === "decon" && (
          report.deconstruction ? (
            <pre className="whitespace-pre-wrap rounded-md p-3 text-xs" style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>
              {JSON.stringify(report.deconstruction, null, 2)}
            </pre>
          ) : (
            <p className="text-xs" style={{ color: "var(--ck-text-dim)" }}>暂无三层拆解（需 AI 连接或走外链解析）。</p>
          )
        )}

        {tab === "voice" && (
          <div className="space-y-4">
            <Card title="口播稿（由 AI 同一次调用产出；外链上传整段视频时最准）">
              {report.fullVoiceover?.trim() ? (
                <pre className="whitespace-pre-wrap text-sm" style={{ color: "var(--ck-text)" }}>{report.fullVoiceover}</pre>
              ) : (
                <p className="text-xs" style={{ color: "var(--ck-text-dim)" }}>
                  暂无口播稿。无 key 时请走外链面板（上传整段视频给 Gemini，它能听到人声转写）；仅传关键帧的 API 调用通常听不到音频。
                </p>
              )}
            </Card>
            {(() => {
              const cp = report.characterProfile as Record<string, unknown> | null;
              if (!cp) return null;
              return (
                <Card title="人物画像">
                  <KV k="年龄" v={cp.age} />
                  <KV k="口音" v={cp.accent} />
                  <KV k="声线" v={cp.voice} />
                  <KV k="重音" v={cp.emphasis} />
                  <KV k="形象" v={cp.visual} />
                </Card>
              );
            })()}
          </div>
        )}

        {tab === "raw" && (
          <pre className="whitespace-pre-wrap rounded-md p-3 text-xs" style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>
            {JSON.stringify(report, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

function ExternalPanel({ runId, onReport }: { runId: string; onReport: (r: SkeletonReport) => void }) {
  const [prompt, setPrompt] = useState<string>("");
  const [uploadHint, setUploadHint] = useState<string>("");
  const [framesDir, setFramesDir] = useState<string>("");
  const [geminiUrl, setGeminiUrl] = useState<string>("https://gemini.google.com/app");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function gen() {
    const p = await buildExternalPrompts(runId);
    setPrompt(p.prompt);
    setUploadHint(p.uploadHint);
    setFramesDir(p.framesDir);
    setGeminiUrl(p.geminiUrl);
    // 生成即自动复制，方便一键去外链粘贴
    try {
      await navigator.clipboard.writeText(p.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用则忽略，用户可手动复制 */
    }
  }

  async function openGemini() {
    try {
      await openUrl(geminiUrl);
    } catch {
      window.open(geminiUrl, "_blank");
    }
  }

  async function ingest() {
    if (!pasted.trim()) return;
    setBusy(true); setErr(null);
    try {
      onReport(await ingestExternalResult(runId, pasted));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border p-4" style={{ borderColor: "var(--ck-border)", background: "rgba(251,191,36,0.06)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "#d9a441" }}>外链 Gemini 拆解（零成本）</h3>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs" style={{ color: "var(--ck-text-dim)" }}>
        <li>点「生成 &amp; 复制 Prompt」（已自动复制到剪贴板）</li>
        <li>点「打开 Gemini」，上传本视频后直接粘贴提示词</li>
        <li>把 Gemini 返回的 JSON 粘到下面，点「解析并合并」</li>
      </ol>

      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={gen} className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97]"
          style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>
          {copied ? "✅ 已复制" : "生成 & 复制 Prompt"}
        </button>
        {prompt && (
          <>
            <button onClick={() => navigator.clipboard.writeText(prompt)} className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97]"
              style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>📋 再次复制</button>
            <button onClick={openGemini} className="rounded-md px-2.5 py-1 text-xs transition active:scale-[0.97]"
              style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}>↗ 打开 Gemini</button>
          </>
        )}
      </div>

      {uploadHint && <div className="mt-2 text-[11px]" style={{ color: "var(--ck-text-dim)" }}>{uploadHint}</div>}
      {framesDir && <div className="mt-1 truncate text-[11px]" style={{ color: "var(--ck-text-dim)" }} title={framesDir}>关键帧目录：{framesDir}</div>}

      <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4} placeholder="把 Gemini 返回的 JSON 粘到这里"
        className="mt-2 w-full rounded-md border px-2 py-1.5 text-xs outline-none"
        style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }} />
      {err && <p className="mt-1 text-[11px]" style={{ color: "#f87171" }}>{err}</p>}
      <button onClick={ingest} disabled={busy} className="mt-2 rounded-md px-3 py-1.5 text-xs font-medium transition active:scale-[0.97] disabled:opacity-50"
        style={{ background: "var(--ck-accent)", color: "#06231f" }}>{busy ? "解析中…" : "解析并合并"}</button>
    </div>
  );
}

// ─────────────────────────── 小组件 ───────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ background: "var(--ck-surface-2)", borderColor: "var(--ck-border)" }}>
      <div className="text-[11px]" style={{ color: "var(--ck-text-dim)" }}>{label}</div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--ck-border)" }}>
      <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--ck-text-dim)" }}>{title}</h3>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="flex gap-2 py-0.5 text-sm">
      <span className="w-10 shrink-0" style={{ color: "var(--ck-text-dim)" }}>{k}</span>
      <span>{typeof v === "string" ? v : "—"}</span>
    </div>
  );
}

function TempoBar({ curve }: { curve: number[] }) {
  if (curve.length === 0) return null;
  const max = Math.max(...curve, 1);
  return (
    <Card title="节奏曲线（每镜头时长）">
      <div className="flex h-16 items-end gap-1">
        {curve.map((v, i) => (
          <div key={i} className="flex-1 rounded-t" style={{ height: `${(v / max) * 100}%`, background: "var(--ck-accent)", minHeight: 3 }} title={`${v}s`} />
        ))}
      </div>
    </Card>
  );
}
