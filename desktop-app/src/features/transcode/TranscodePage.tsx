import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  FolderOpen,
  FilePlus2,
  FolderPlus,
  Trash2,
  Play,
  ChevronUp,
  ChevronDown,
  Terminal,
  Copy,
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronRight,
  RotateCcw,
  StopCircle,
  UploadCloud,
  FileVideo,
  Loader2,
  Ban,
} from "lucide-react";
import {
  pickVideoFiles,
  pickFolder,
  pickOutputDir,
  listVideosInFolder,
  startTranscode,
  cancelTranscode,
  onTranscodeProgress,
  onTranscodeLog,
  onTranscodeVerify,
  openInExplorer,
  revealItem,
  type TranscodeProgress,
  type TranscodeParams,
  type VideoCodec,
  type LogLine,
  type VerifyReport,
  type VerifyStatus,
} from "../../lib/ipc";

const VIDEO_EXT_RE = /\.(mp4|mov|mkv|avi|webm|m4v|flv|ts)$/i;

interface LogEntry extends LogLine {
  ts: string;
}

interface VerifyEntry {
  report: VerifyReport;
  at: string;
}

type FileState = TranscodeProgress;

const SPEED_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
];

// 平台预设：一键套用「防二次压缩」推荐规格。各平台收流规格接近，
// 这里统一给到「保原分辨率帧率 + 智能去黑边 + 高码率(低CRF) + 1080p 上限」的减伤配置。
type PlatformKey = "douyin" | "shipinhao" | "xiaohongshu" | "reels" | "custom";

interface PresetBundle {
  codec: VideoCodec;
  crf: number;
  audioBitrate: number;
  smartCrop: boolean;
  limit1080p: boolean;
  keepFps: boolean;
  preset: string;
}

// 注意：smartCrop 默认关闭——黑边自动探测可能误判（暗场/纯黑背景会被误裁），
// 且大多数视频本就无黑边。确有黑边的用户再手动开启。
const PLATFORM_PRESETS: Record<Exclude<PlatformKey, "custom">, PresetBundle> = {
  douyin: { codec: "h264", crf: 18, audioBitrate: 192, smartCrop: false, limit1080p: true, keepFps: true, preset: "medium" },
  shipinhao: { codec: "h264", crf: 18, audioBitrate: 192, smartCrop: false, limit1080p: true, keepFps: true, preset: "medium" },
  xiaohongshu: { codec: "h264", crf: 18, audioBitrate: 192, smartCrop: false, limit1080p: true, keepFps: true, preset: "medium" },
  reels: { codec: "h264", crf: 18, audioBitrate: 192, smartCrop: false, limit1080p: true, keepFps: true, preset: "slow" },
};

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  douyin: "抖音 / TikTok",
  shipinhao: "微信视频号",
  xiaohongshu: "小红书",
  reels: "Instagram Reels",
  custom: "自定义",
};

export default function TranscodePage() {
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [running, setRunning] = useState(false);

  // 防压缩重编码参数（默认对齐抖音/TikTok 减伤推荐）
  const [platform, setPlatform] = useState<PlatformKey>("douyin");
  const [codec, setCodec] = useState<VideoCodec>("h264");
  const [crf, setCrf] = useState(18);
  const [audioBitrate, setAudioBitrate] = useState(192);
  const [speedPreset, setSpeedPreset] = useState("medium");
  const [smartCrop, setSmartCrop] = useState(false);
  const [limit1080p, setLimit1080p] = useState(true);
  const [keepFps, setKeepFps] = useState(true);
  const [fps, setFps] = useState(30);
  const [concurrency, setConcurrency] = useState(4);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [suffix, setSuffix] = useState("_hq");

  // 运行日志（UI 可见）
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  // 处理后验证报告（按文件）
  const [verifies, setVerifies] = useState<Record<string, VerifyEntry>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 拖拽导入高亮
  const [dragOver, setDragOver] = useState(false);

  const unlistenRef = useRef<(() => void) | null>(null);
  const unlistenLogRef = useRef<(() => void) | null>(null);
  const unlistenVerifyRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onTranscodeProgress((p) => {
      setFiles((prev) => ({ ...prev, [p.file]: p }));
    }).then((un) => (unlistenRef.current = un));
    onTranscodeLog((line) => {
      const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      // 上限 500 行，避免长时间运行内存膨胀。
      setLogs((prev) => [...prev, { ...line, ts }].slice(-500));
    }).then((un) => (unlistenLogRef.current = un));
    onTranscodeVerify((report) => {
      const at = new Date().toLocaleString("zh-CN", { hour12: false });
      setVerifies((prev) => ({ ...prev, [report.file]: { report, at } }));
    }).then((un) => (unlistenVerifyRef.current = un));
    return () => {
      unlistenRef.current?.();
      unlistenLogRef.current?.();
      unlistenVerifyRef.current?.();
    };
  }, []);

  // 拖拽导入：监听 webview 的文件拖放事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          void handleDroppedPaths(event.payload.paths);
        } else {
          setDragOver(false);
        }
      })
      .then((un) => (unlisten = un));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errorLogCount = logs.filter((l) => l.level === "error").length;

  // 验证汇总
  const verifyList = Object.values(verifies);
  const verifyPass = verifyList.filter((v) => v.report.overall === "ok").length;
  const verifyWarn = verifyList.filter((v) => v.report.overall === "warn").length;
  const verifyFail = verifyList.filter((v) => v.report.overall === "fail").length;

  function toggleExpand(file: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  function applyPlatform(key: PlatformKey) {
    setPlatform(key);
    if (key === "custom") return;
    const b = PLATFORM_PRESETS[key];
    setCodec(b.codec);
    setCrf(b.crf);
    setAudioBitrate(b.audioBitrate);
    setSmartCrop(b.smartCrop);
    setLimit1080p(b.limit1080p);
    setKeepFps(b.keepFps);
    setSpeedPreset(b.preset);
  }

  // 任一参数被手动改动 → 切到「自定义」，避免误导用户以为还是平台预设。
  function markCustom() {
    setPlatform("custom");
  }

  const fileList = Object.values(files);
  const doneCount = fileList.filter((f) => f.status === "done").length;
  const failedList = fileList.filter((f) => f.status === "error");
  const overallPercent = fileList.length
    ? Math.round(
        fileList.reduce(
          (s, f) => s + (f.status === "done" ? 100 : f.status === "running" ? f.percent : 0),
          0,
        ) / fileList.length,
      )
    : 0;

  const firstInput = fileList[0]?.file ?? null;
  // 批量留空输出目录时，各视频会输出到各自源目录——若来源目录不止一个，给出提示。
  const scatteredOutput = !outputDir && new Set(fileList.map((f) => dirname(f.file))).size > 1;

  // 前端侧日志（与后端日志同面板），用于把"打开目录失败"等操作结果反馈给用户。
  function uiLog(level: "info" | "error", message: string) {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((prev) => [...prev, { level, message, ts }].slice(-500));
  }

  // 打开输出位置：显式设了输出目录就直接打开它；否则定位首个已完成的产物（适配批量分散输出）。
  async function onOpenOutput() {
    try {
      if (outputDir) {
        await openInExplorer(outputDir);
        return;
      }
      const done = fileList.find((f) => f.status === "done" && f.outputPath);
      if (done?.outputPath) {
        await revealItem(done.outputPath);
        return;
      }
      if (firstInput) {
        await openInExplorer(dirname(firstInput));
        return;
      }
      uiLog("error", "没有可打开的输出目录");
    } catch (e) {
      uiLog("error", `打开输出目录失败：${String(e)}`);
    }
  }

  // 定位单个产物文件
  async function onRevealFile(p?: string | null) {
    if (!p) return;
    try {
      await revealItem(p);
    } catch (e) {
      uiLog("error", `定位文件失败：${String(e)}`);
    }
  }

  function addPaths(paths: string[]) {
    setFiles((prev) => {
      const next = { ...prev };
      for (const p of paths) {
        if (!next[p]) next[p] = { file: p, status: "pending", percent: 0 };
      }
      return next;
    });
  }

  // 处理拖入的路径：直接是视频就加入；否则当文件夹尝试递归收集。
  async function handleDroppedPaths(paths: string[]) {
    const direct = paths.filter((p) => VIDEO_EXT_RE.test(p));
    const folders = paths.filter((p) => !VIDEO_EXT_RE.test(p));
    if (direct.length) addPaths(direct);
    let folderCount = 0;
    for (const f of folders) {
      try {
        const vids = await listVideosInFolder(f);
        if (vids.length) {
          addPaths(vids);
          folderCount += vids.length;
        }
      } catch {
        /* 不是文件夹或无视频，忽略 */
      }
    }
    if (direct.length + folderCount === 0) {
      uiLog("error", "拖入的内容里没有可识别的视频文件");
    }
  }

  async function onAddFiles() {
    addPaths(await pickVideoFiles());
  }

  async function onAddFolder() {
    const folder = await pickFolder();
    if (folder) addPaths(await listVideosInFolder(folder));
  }

  function onClear() {
    if (running) return;
    setFiles({});
    setVerifies({});
    setExpanded(new Set());
  }

  function removeFile(file: string) {
    if (running) return;
    setFiles((prev) => {
      const n = { ...prev };
      delete n[file];
      return n;
    });
    setVerifies((prev) => {
      const n = { ...prev };
      delete n[file];
      return n;
    });
    setExpanded((prev) => {
      const n = new Set(prev);
      n.delete(file);
      return n;
    });
  }

  async function onChooseOutput() {
    const dir = await pickOutputDir();
    if (dir) setOutputDir(dir);
  }

  function buildParams(inputs: string[]): TranscodeParams {
    return {
      inputs,
      outputDir,
      suffix,
      codec,
      crf,
      preset: speedPreset,
      audioBitrate,
      smartCrop,
      limit1080p,
      keepFps,
      fps,
      concurrency,
    };
  }

  // 处理一批文件：先把这些文件状态重置为等待、清掉旧验证，再启动后端。
  async function runInputs(inputs: string[]) {
    if (inputs.length === 0 || running) return;
    setFiles((prev) => {
      const next = { ...prev };
      for (const i of inputs) next[i] = { file: i, status: "pending", percent: 0 };
      return next;
    });
    setVerifies((prev) => {
      const next = { ...prev };
      for (const i of inputs) delete next[i];
      return next;
    });
    setRunning(true);
    try {
      await startTranscode(buildParams(inputs));
    } catch (e) {
      uiLog("error", `启动转码失败：${String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  function onStart() {
    void runInputs(Object.keys(files));
  }

  async function onCancel() {
    try {
      await cancelTranscode();
      uiLog("info", "已请求取消，正在停止当前任务…");
    } catch (e) {
      uiLog("error", `取消失败：${String(e)}`);
    }
  }

  function retryFiles(inputs: string[]) {
    void runInputs(inputs);
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <h1 className="text-xl font-semibold">视频批量重编码（防二次压缩）</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
        上传抖音/TikTok 等平台前，把视频重编码成「高码率、规格对口」的源——平台服务端
        转码时几乎不用再压，最大程度保住画质。默认保留原始分辨率与帧率，智能识别并去除黑边。
      </p>

      {/* 导入区 */}
      <section
        className="mt-6 rounded-xl border p-5"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">导入视频</span>
          <span className="flex items-center gap-3 text-xs" style={{ color: "var(--ck-text-dim)" }}>
            {verifyList.length > 0 && (
              <span className="flex items-center gap-2">
                <span title="验证通过" className="flex items-center gap-1" style={{ color: "var(--ck-accent)" }}>
                  <CheckCircle2 size={13} /> {verifyPass}
                </span>
                {verifyWarn > 0 && (
                  <span title="警告" className="flex items-center gap-1" style={{ color: "#e6b450" }}>
                    <AlertTriangle size={13} /> {verifyWarn}
                  </span>
                )}
                {verifyFail > 0 && (
                  <span title="失败" className="flex items-center gap-1" style={{ color: "var(--ck-danger)" }}>
                    <XCircle size={13} /> {verifyFail}
                  </span>
                )}
                <span className="opacity-50">·</span>
              </span>
            )}
            共 {fileList.length} 个视频
          </span>
        </div>

        <div
          className="mt-3 flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm transition-colors"
          style={{
            borderColor: dragOver ? "var(--ck-accent)" : "var(--ck-border)",
            background: dragOver ? "color-mix(in srgb, var(--ck-accent) 12%, transparent)" : "transparent",
            color: "var(--ck-text-dim)",
          }}
        >
          {fileList.length === 0 ? (
            <span className="flex flex-col items-center gap-2 py-2">
              <UploadCloud size={28} style={{ color: dragOver ? "var(--ck-accent)" : "var(--ck-text-dim)" }} />
              {dragOver ? "松手即可导入" : "把视频文件或文件夹拖到这里，或用下方按钮选择"}
            </span>
          ) : (
            <ul className="max-h-72 w-full space-y-1.5 overflow-y-auto text-left">
              {fileList.map((f) => (
                <FileRow
                  key={f.file}
                  state={f}
                  verify={verifies[f.file]}
                  expanded={expanded.has(f.file)}
                  running={running}
                  logs={logs}
                  onToggle={() => toggleExpand(f.file)}
                  onReveal={() => onRevealFile(f.outputPath)}
                  onRetry={() => retryFiles([f.file])}
                  onRemove={() => removeFile(f.file)}
                  onOpenLog={() => setLogOpen(true)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Btn onClick={onAddFiles} icon={<FilePlus2 size={16} />}>
            选择文件
          </Btn>
          <Btn onClick={onAddFolder} icon={<FolderPlus size={16} />}>
            选择文件夹
          </Btn>
          <Btn onClick={onClear} icon={<Trash2 size={16} />} disabled={running}>
            清空列表
          </Btn>
        </div>
      </section>

      {/* 平台预设 */}
      <section
        className="mt-5 rounded-xl border p-5"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="mb-3 text-sm font-medium">平台预设（一键套用减伤推荐规格）</div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PLATFORM_LABELS) as PlatformKey[]).map((k) => (
            <button
              key={k}
              onClick={() => applyPlatform(k)}
              className="rounded-lg border px-3.5 py-2 text-sm transition duration-75 hover:brightness-125 active:scale-[0.96]"
              style={{
                borderColor: platform === k ? "var(--ck-accent)" : "var(--ck-border)",
                background: platform === k ? "var(--ck-accent)" : "var(--ck-surface-2)",
                color: platform === k ? "#06231f" : "var(--ck-text)",
              }}
            >
              {PLATFORM_LABELS[k]}
            </button>
          ))}
        </div>
      </section>

      {/* 参数区 */}
      <section
        className="mt-4 rounded-xl border p-5"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="mb-4 text-sm font-medium">编码参数</div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="编码器">
            <Select
              value={codec}
              onChange={(v) => {
                setCodec(v as VideoCodec);
                markCustom();
              }}
              options={[
                { value: "h264", label: "H.264（兼容最好）" },
                { value: "h265", label: "H.265（更小/高清通道）" },
              ]}
            />
          </Field>
          <Field label="CRF 画质（越小越清晰/码率越高）">
            <NumberInput
              value={crf}
              min={14}
              max={28}
              onChange={(v) => {
                setCrf(v);
                markCustom();
              }}
            />
          </Field>
          <Field label="音频码率 (kbps)">
            <NumberInput
              value={audioBitrate}
              min={64}
              max={320}
              step={32}
              onChange={(v) => {
                setAudioBitrate(v);
                markCustom();
              }}
            />
          </Field>
          <Field label="编码速度 preset">
            <Select
              value={speedPreset}
              onChange={(v) => {
                setSpeedPreset(String(v));
                markCustom();
              }}
              options={SPEED_PRESETS.map((p) => ({ value: p, label: p }))}
            />
          </Field>
          <Field label="并发数">
            <NumberInput value={concurrency} min={1} max={16} onChange={setConcurrency} />
          </Field>
          <Field label="文件名后缀">
            <TextInput value={suffix} onChange={setSuffix} />
          </Field>
        </div>

        {/* 智能开关 */}
        <div className="mt-5 space-y-3">
          <Toggle
            checked={smartCrop}
            onChange={(v) => {
              setSmartCrop(v);
              markCustom();
            }}
            label="智能去黑边（默认关闭）"
            hint="自动探测黑边后裁剪。注意：可能误判（暗场/纯黑背景会被误裁），仅在确有黑边时开启"
          />
          <Toggle
            checked={limit1080p}
            onChange={(v) => {
              setLimit1080p(v);
              markCustom();
            }}
            label="限制 1080p 以内"
            hint="超过 1080×1920 才缩小，绝不放大（放大无意义且更糊）"
          />
          <Toggle
            checked={keepFps}
            onChange={(v) => {
              setKeepFps(v);
              markCustom();
            }}
            label="保留原始帧率"
            hint="关闭后统一帧率（强行改帧率可能导致顿挫掉质）"
          />
          {!keepFps && (
            <div className="pl-1">
              <Field label="统一目标帧率">
                <Select
                  value={fps}
                  onChange={(v) => {
                    setFps(Number(v));
                    markCustom();
                  }}
                  options={[24, 30, 60].map((n) => ({ value: n, label: String(n) }))}
                />
              </Field>
            </div>
          )}
        </div>

        <div className="mt-5">
          <Field label="输出目录（留空 = 原视频同目录）">
            <div className="flex gap-2">
              <div
                className="flex-1 truncate rounded-md px-3 py-2 text-xs"
                style={{ background: "var(--ck-surface-2)", color: "var(--ck-text-dim)" }}
                title={outputDir ?? ""}
              >
                {outputDir ?? "原视频同目录"}
              </div>
              <Btn onClick={onChooseOutput} icon={<FolderOpen size={16} />}>
                选择
              </Btn>
              {outputDir && (
                <Btn onClick={() => setOutputDir(null)} icon={<X size={16} />}>
                  清除
                </Btn>
              )}
            </div>
          </Field>
          {scatteredOutput && (
            <p className="mt-2 text-[11px]" style={{ color: "#e6b450" }}>
              未设输出目录：各视频将分别输出到各自的源目录。可在上方列表点击单个文件右侧的「定位」按钮逐个打开。
            </p>
          )}
        </div>
      </section>

      <p className="mt-4 text-xs leading-relaxed" style={{ color: "var(--ck-text-dim)" }}>
        提示：平台一定会对上传视频再压一次，本工具无法消除这一步，只能把「被压之前」的素材
        做到最优。发布时记得在 App 内打开「高清上传 / HD」开关，效果叠加更明显。
      </p>

      {/* 底部固定动作栏：始终可见、放在业务最后一步 */}
      <div
        className="sticky bottom-0 z-30 -mx-8 mt-6 border-t px-8 pt-2.5 pb-3"
        style={{ background: "var(--ck-bg)", borderColor: "var(--ck-border)" }}
      >
        {/* 总进度条（仅运行中或有完成时显示） */}
        {(running || doneCount > 0 || failedList.length > 0) && (
          <div className="mb-2.5">
            <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
              <span>
                总进度 {overallPercent}%
                <span className="ml-2">
                  完成 {doneCount}/{fileList.length}
                  {failedList.length > 0 && (
                    <span style={{ color: "var(--ck-danger)" }}> · 失败 {failedList.length}</span>
                  )}
                </span>
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--ck-surface-2)" }}>
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${overallPercent}%`, background: "var(--ck-accent)" }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          {running ? (
            <button
              onClick={onCancel}
              className="flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-semibold shadow-lg transition duration-75 hover:brightness-110 active:scale-[0.97]"
              style={{ background: "var(--ck-danger)", color: "#fff" }}
            >
              <StopCircle size={16} />
              停止处理
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={fileList.length === 0}
              className="flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-semibold shadow-lg transition duration-75 hover:brightness-110 active:scale-[0.97] disabled:opacity-40 disabled:hover:brightness-100 disabled:active:scale-100"
              style={{ background: "var(--ck-accent)", color: "#06231f" }}
            >
              <Play size={16} />
              {`开始处理${fileList.length ? ` (${fileList.length})` : ""}`}
            </button>
          )}

          {!running && failedList.length > 0 && (
            <Btn onClick={() => retryFiles(failedList.map((f) => f.file))} icon={<RotateCcw size={16} />}>
              重试失败 ({failedList.length})
            </Btn>
          )}

          <Btn
            onClick={onOpenOutput}
            icon={<FolderOpen size={16} />}
            disabled={fileList.length === 0 && !outputDir}
          >
            打开输出目录
          </Btn>

          <button
            onClick={() => setLogOpen((v) => !v)}
            className="ml-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition duration-75 hover:brightness-125 active:scale-95"
            style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
          >
            <Terminal size={14} />
            日志
            {errorLogCount > 0 && (
              <span
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
                style={{ background: "var(--ck-danger)", color: "#fff" }}
              >
                {errorLogCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <LogConsole logs={logs} open={logOpen} onClose={() => setLogOpen(false)} onClear={() => setLogs([])} />
    </div>
  );
}

function LogConsole({
  logs,
  open,
  onClose,
  onClear,
}: {
  logs: LogEntry[];
  open: boolean;
  onClose: () => void;
  onClear: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 新日志进来时，若面板展开则自动滚到底部。
  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  async function copyAll() {
    const text = logs.map((l) => `[${l.ts}] ${l.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed bottom-16 right-4 z-50 flex w-[480px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border shadow-2xl"
      style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: "var(--ck-border)" }}
      >
        <span className="flex items-center gap-2 text-xs font-medium">
          <Terminal size={14} />
          运行日志
          <span style={{ color: "var(--ck-text-dim)" }}>· {logs.length} 行</span>
        </span>
        <div className="flex items-center gap-1">
          <IconBtn onClick={copyAll} title="复制全部">
            <Copy size={14} />
          </IconBtn>
          <IconBtn onClick={onClear} title="清空">
            <Trash2 size={14} />
          </IconBtn>
          <IconBtn onClick={onClose} title="收起">
            <X size={14} />
          </IconBtn>
        </div>
      </div>
      <div
        ref={bodyRef}
        className="max-h-72 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
        style={{ background: "var(--ck-surface-2)" }}
      >
        {logs.length === 0 ? (
          <div style={{ color: "var(--ck-text-dim)" }}>暂无日志，开始处理后这里会实时输出。</div>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-all"
              style={{ color: l.level === "error" ? "var(--ck-danger)" : "var(--ck-text)" }}
            >
              <span style={{ color: "var(--ck-text-dim)" }}>[{l.ts}] </span>
              {l.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-6 w-6 items-center justify-center rounded transition duration-75 hover:bg-[var(--ck-surface-2)] hover:text-[var(--ck-text)] active:scale-90"
      style={{ color: "var(--ck-text-dim)" }}
    >
      {children}
    </button>
  );
}

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function dirname(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

function StatusBadge({ state }: { state: FileState }) {
  const base = "flex shrink-0 items-center gap-1 font-medium";
  switch (state.status) {
    case "running":
      return (
        <span className={base} style={{ color: "var(--ck-accent)" }} title="正在转码">
          <Loader2 size={13} className="animate-spin" />
          {state.percent}%
        </span>
      );
    case "done":
      return (
        <span className={base} style={{ color: "var(--ck-accent)" }} title="转码完成">
          <CheckCircle2 size={13} />
          完成
        </span>
      );
    case "error":
      return (
        <span className={base} style={{ color: "var(--ck-danger)" }} title={state.message ?? "处理失败"}>
          <XCircle size={13} />
          失败
        </span>
      );
    case "cancelled":
      return (
        <span className={base} style={{ color: "var(--ck-text-dim)" }} title="已取消">
          <Ban size={13} />
          已取消
        </span>
      );
    default:
      // pending：本地文件选中即导入成功，等待点「开始处理」。
      return (
        <span className={base} style={{ color: "#5bbfa5" }} title="已导入，待处理">
          <CheckCircle2 size={13} />
          就绪
        </span>
      );
  }
}

const VERIFY_META: Record<VerifyStatus, { color: string; Icon: typeof CheckCircle2; label: string }> = {
  ok: { color: "var(--ck-accent)", Icon: CheckCircle2, label: "验证通过" },
  warn: { color: "#e6b450", Icon: AlertTriangle, label: "有警告" },
  fail: { color: "var(--ck-danger)", Icon: XCircle, label: "验证失败" },
};

function FileRow({
  state,
  verify,
  expanded,
  running,
  logs,
  onToggle,
  onReveal,
  onRetry,
  onRemove,
  onOpenLog,
}: {
  state: FileState;
  verify?: VerifyEntry;
  expanded: boolean;
  running: boolean;
  logs: LogEntry[];
  onToggle: () => void;
  onReveal: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onOpenLog: () => void;
}) {
  const isRunning = state.status === "running";
  const isDone = state.status === "done";
  const isError = state.status === "error";
  const isCancelled = state.status === "cancelled";
  const canReveal = isDone && !!state.outputPath;
  const canExpand = !!verify || isError;
  const vmeta = verify ? VERIFY_META[verify.report.overall] : null;

  return (
    <li className="overflow-hidden rounded text-xs" style={{ background: "var(--ck-surface-2)" }}>
      <div
        className={`flex items-center justify-between gap-3 px-2 py-2 ${canExpand ? "cursor-pointer" : ""}`}
        onClick={() => canExpand && onToggle()}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {canExpand ? (
            <ChevronRight
              size={13}
              className="shrink-0 transition-transform"
              style={{ color: "var(--ck-text-dim)", transform: expanded ? "rotate(90deg)" : "none" }}
            />
          ) : (
            <FileVideo size={13} className="shrink-0" style={{ color: "var(--ck-text-dim)" }} />
          )}
          <span className="truncate" title={state.file}>
            {basename(state.file)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {(isError || isCancelled) && !running && (
            <IconBtn onClick={(e) => { e?.stopPropagation(); onRetry(); }} title="重试该文件">
              <RotateCcw size={13} />
            </IconBtn>
          )}
          {canReveal && (
            <IconBtn onClick={(e) => { e?.stopPropagation(); onReveal(); }} title="在文件管理器中定位产物">
              <FolderOpen size={13} />
            </IconBtn>
          )}
          {!running && (
            <IconBtn onClick={(e) => { e?.stopPropagation(); onRemove(); }} title="从列表移除">
              <X size={13} />
            </IconBtn>
          )}
          {vmeta && (
            <span className="flex items-center gap-1" style={{ color: vmeta.color }} title={vmeta.label}>
              <vmeta.Icon size={14} />
            </span>
          )}
          <StatusBadge state={state} />
        </span>
      </div>

      {/* 单文件进度条 */}
      {isRunning && (
        <div className="h-1 w-full" style={{ background: "var(--ck-border)" }}>
          <div
            className="h-full transition-[width] duration-300"
            style={{ width: `${state.percent}%`, background: "var(--ck-accent)" }}
          />
        </div>
      )}

      {/* 展开详情：失败原因 / 验证逐项 */}
      {canExpand && expanded && (
        <div className="border-t px-3 py-2" style={{ borderColor: "var(--ck-border)" }}>
          {isError ? (
            <ErrorDetail state={state} logs={logs} onOpenLog={onOpenLog} onRetry={onRetry} running={running} />
          ) : verify ? (
            <>
              <div className="mb-1.5 flex items-center justify-between text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
                <span>处理后验证 · {verify.at}</span>
                <span>
                  {verify.report.items.filter((i) => i.status === "ok").length}/{verify.report.items.length} 通过
                </span>
              </div>
              <div className="space-y-1">
                {verify.report.items.map((it) => {
                  const m = VERIFY_META[it.status];
                  return (
                    <div key={it.key} className="flex items-center gap-2 text-[11px]">
                      <m.Icon size={12} style={{ color: m.color, flexShrink: 0 }} />
                      <span className="w-32 shrink-0" style={{ color: "var(--ck-text)" }}>
                        {it.label}
                      </span>
                      <span
                        className="truncate"
                        style={{ color: it.status === "ok" ? "var(--ck-text-dim)" : m.color }}
                        title={`期望：${it.expected}`}
                      >
                        {it.actual}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}

function ErrorDetail({
  state,
  logs,
  onOpenLog,
  onRetry,
  running,
}: {
  state: FileState;
  logs: LogEntry[];
  onOpenLog: () => void;
  onRetry: () => void;
  running: boolean;
}) {
  // 找出与该文件相关的日志行（按文件名匹配），方便就地查看。
  const name = basename(state.file);
  const related = logs.filter((l) => l.message.includes(name)).slice(-8);

  async function copyReason() {
    try {
      await navigator.clipboard.writeText(state.message ?? "");
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium" style={{ color: "var(--ck-danger)" }}>
        失败原因
      </div>
      <div
        className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded p-2 font-mono text-[11px]"
        style={{ background: "var(--ck-bg)", color: "var(--ck-text)" }}
      >
        {state.message || "未知错误（无返回信息）"}
      </div>
      {related.length > 0 && (
        <div>
          <div className="mb-1 text-[11px]" style={{ color: "var(--ck-text-dim)" }}>
            相关日志
          </div>
          <div
            className="max-h-28 overflow-y-auto rounded p-2 font-mono text-[10px] leading-relaxed"
            style={{ background: "var(--ck-bg)" }}
          >
            {related.map((l, i) => (
              <div
                key={i}
                className="whitespace-pre-wrap break-all"
                style={{ color: l.level === "error" ? "var(--ck-danger)" : "var(--ck-text-dim)" }}
              >
                [{l.ts}] {l.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {!running && (
          <button
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition duration-75 hover:brightness-125 active:scale-95"
            style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
          >
            <RotateCcw size={12} /> 重试
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); copyReason(); }}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition duration-75 hover:brightness-125 active:scale-95"
          style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
        >
          <Copy size={12} /> 复制原因
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenLog(); }}
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition duration-75 hover:brightness-125 active:scale-95"
          style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
        >
          <Terminal size={12} /> 查看完整日志
        </button>
      </div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  icon,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition duration-75 hover:brightness-125 active:scale-[0.96] disabled:opacity-40 disabled:hover:brightness-100 disabled:active:scale-100"
      style={{ borderColor: "var(--ck-border)", background: "var(--ck-surface-2)" }}
    >
      {icon}
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs" style={{ color: "var(--ck-text-dim)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 text-left transition active:opacity-70"
    >
      <span
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: checked ? "var(--ck-accent)" : "var(--ck-surface-2)" }}
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </span>
      <span>
        <span className="block text-sm" style={{ color: "var(--ck-text)" }}>
          {label}
        </span>
        {hint && (
          <span className="block text-xs" style={{ color: "var(--ck-text-dim)" }}>
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--ck-surface-2)",
  borderColor: "var(--ck-border)",
  color: "var(--ck-text)",
};

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const stepBy = (dir: number) => {
    const s = step ?? 1;
    let next = value + dir * s;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(next);
  };
  return (
    <div className="relative">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ck-number w-full rounded-md border px-3 py-2 pr-9 text-sm outline-none transition-colors"
        style={inputStyle}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 flex-col gap-px">
        <StepBtn onClick={() => stepBy(1)} aria="增加">
          <ChevronUp size={12} />
        </StepBtn>
        <StepBtn onClick={() => stepBy(-1)} aria="减少">
          <ChevronDown size={12} />
        </StepBtn>
      </div>
    </div>
  );
}

function StepBtn({
  children,
  onClick,
  aria,
}: {
  children: React.ReactNode;
  onClick: () => void;
  aria: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={aria}
      onClick={onClick}
      className="flex h-[15px] w-5 items-center justify-center rounded-sm transition duration-75 hover:bg-[var(--ck-border)] hover:text-[var(--ck-text)] active:scale-90"
      style={{ color: "var(--ck-text-dim)" }}
    >
      {children}
    </button>
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ck-input w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors"
      style={inputStyle}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string | number;
  onChange: (v: string | number) => void;
  options: { value: string | number; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ck-select w-full rounded-md border px-3 py-2 pr-9 text-sm outline-none transition-colors"
        style={inputStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        style={{ color: "var(--ck-text-dim)" }}
      />
    </div>
  );
}
