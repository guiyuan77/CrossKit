import { useEffect, useState } from "react";
import { getLlmStatus, type StatusInfo } from "../../lib/llm";

/*
  侧边栏全局 AI 状态小圆点：绿=已连接(API)，黄=仅外链，灰=未连接。
  点击跳转设置页。每 15s 刷新一次，窗口聚焦时也刷新。
*/
export default function AiStatusDot({ onClick }: { onClick?: () => void }) {
  const [status, setStatus] = useState<StatusInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => getLlmStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    refresh();
    const t = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", refresh); };
  }, []);

  const { color, text } = describe(status);

  return (
    <button
      onClick={onClick}
      title="AI 连接状态 · 点击前往设置"
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs transition active:scale-[0.98]"
      style={{ color: "var(--ck-text-dim)" }}
    >
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{text}</span>
    </button>
  );
}

function describe(s: StatusInfo | null): { color: string; text: string } {
  if (!s) return { color: "var(--ck-text-dim)", text: "AI：检查中…" };
  if (s.mode === "weblink") return { color: "#fbbf24", text: "AI：仅外链模式" };
  if (s.connected) return { color: "#34d399", text: `AI：${s.activeModel ?? "已连接"}` };
  return { color: "#f87171", text: "AI：未连接" };
}
