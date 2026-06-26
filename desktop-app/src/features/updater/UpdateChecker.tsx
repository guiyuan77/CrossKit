import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, RefreshCw, X, Sparkles } from "lucide-react";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

/**
 * 启动时静默检查更新；有新版本则弹窗提示，支持一键下载安装并重启。
 * 任何检查/网络错误都静默忽略（不打扰用户）。
 */
export default function UpdateChecker() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [percent, setPercent] = useState(0);
  const [errMsg, setErrMsg] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    (async () => {
      try {
        const up = await check();
        if (up) {
          setUpdate(up);
          setPhase("available");
        }
      } catch {
        // 无网络 / 尚无发布 / 开发环境等：静默忽略
      }
    })();
  }, []);

  async function onUpdate() {
    if (!update) return;
    setPhase("downloading");
    setPercent(0);
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          downloaded += e.data.chunkLength;
          if (total > 0) setPercent(Math.min(100, Math.round((downloaded / total) * 100)));
        } else if (e.event === "Finished") {
          setPercent(100);
        }
      });
      setPhase("ready");
      // 安装完成，重启应用到新版本
      await relaunch();
    } catch (err) {
      setErrMsg(String(err));
      setPhase("error");
    }
  }

  if (!update || dismissed) return null;
  if (phase === "idle") return null;

  const downloading = phase === "downloading";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div
        className="w-[420px] max-w-[90vw] rounded-xl border p-5 shadow-2xl"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} style={{ color: "var(--ck-accent)" }} />
            <span className="text-base font-semibold">发现新版本</span>
          </div>
          {!downloading && phase !== "ready" && (
            <button
              onClick={() => setDismissed(true)}
              className="flex h-7 w-7 items-center justify-center rounded transition duration-75 hover:bg-[var(--ck-surface-2)] active:scale-90"
              style={{ color: "var(--ck-text-dim)" }}
              title="稍后再说"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="mt-3 text-sm" style={{ color: "var(--ck-text-dim)" }}>
          <p>
            当前版本 <span style={{ color: "var(--ck-text)" }}>{update.currentVersion}</span> → 新版本{" "}
            <span className="font-semibold" style={{ color: "var(--ck-accent)" }}>{update.version}</span>
          </p>
          {update.body ? (
            <div
              className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded p-2 text-xs"
              style={{ background: "var(--ck-surface-2)", color: "var(--ck-text)" }}
            >
              {update.body}
            </div>
          ) : null}
        </div>

        {downloading && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
              <span>正在下载并安装…</span>
              <span>{percent}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ck-surface-2)" }}>
              <div
                className="h-full rounded-full transition-[width] duration-200"
                style={{ width: `${percent}%`, background: "var(--ck-accent)" }}
              />
            </div>
          </div>
        )}

        {phase === "ready" && (
          <p className="mt-4 text-sm" style={{ color: "var(--ck-accent)" }}>
            安装完成，正在重启应用…
          </p>
        )}

        {phase === "error" && (
          <div className="mt-4">
            <p className="text-xs" style={{ color: "var(--ck-danger)" }}>
              更新失败：{errMsg}
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
              可稍后重试，或到 Releases 手动下载安装。
            </p>
          </div>
        )}

        {(phase === "available" || phase === "error") && (
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setDismissed(true)}
              className="rounded-lg border px-4 py-2 text-sm transition duration-75 hover:brightness-125 active:scale-95"
              style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
            >
              稍后
            </button>
            <button
              onClick={onUpdate}
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition duration-75 hover:brightness-110 active:scale-[0.97]"
              style={{ background: "var(--ck-accent)", color: "#06231f" }}
            >
              {phase === "error" ? <RefreshCw size={15} /> : <Download size={15} />}
              {phase === "error" ? "重试" : "立即更新"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
