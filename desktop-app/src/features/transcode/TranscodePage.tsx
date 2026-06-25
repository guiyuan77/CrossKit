import { useEffect, useRef, useState } from "react";
import { FolderOpen, FilePlus2, FolderPlus, Trash2, Play } from "lucide-react";
import {
  pickVideoFiles,
  pickFolder,
  pickOutputDir,
  listVideosInFolder,
  startTranscode,
  onTranscodeProgress,
  openInExplorer,
  type TranscodeProgress,
  type TranscodeParams,
} from "../../lib/ipc";

type FileState = TranscodeProgress;

const PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
];

export default function TranscodePage() {
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [running, setRunning] = useState(false);

  // 参数（默认值对齐 TikTok 友好规格）
  const [width] = useState(1080);
  const [height] = useState(1920);
  const [fps, setFps] = useState(30);
  const [crf, setCrf] = useState(18);
  const [audioBitrate, setAudioBitrate] = useState(192);
  const [preset, setPreset] = useState("medium");
  const [concurrency, setConcurrency] = useState(5);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [suffix, setSuffix] = useState("_1080p");

  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onTranscodeProgress((p) => {
      setFiles((prev) => ({ ...prev, [p.file]: p }));
    }).then((un) => (unlistenRef.current = un));
    return () => unlistenRef.current?.();
  }, []);

  const fileList = Object.values(files);
  const doneCount = fileList.filter((f) => f.status === "done").length;

  function addPaths(paths: string[]) {
    setFiles((prev) => {
      const next = { ...prev };
      for (const p of paths) {
        if (!next[p]) next[p] = { file: p, status: "pending", percent: 0 };
      }
      return next;
    });
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
  }

  async function onChooseOutput() {
    const dir = await pickOutputDir();
    if (dir) setOutputDir(dir);
  }

  async function onStart() {
    const inputs = Object.keys(files);
    if (inputs.length === 0 || running) return;
    setRunning(true);
    const params: TranscodeParams = {
      inputs,
      outputDir,
      suffix,
      width,
      height,
      fps,
      crf,
      preset,
      audioBitrate,
      concurrency,
    };
    try {
      await startTranscode(params);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <h1 className="text-xl font-semibold">视频批量转换</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
        将竖屏短视频统一缩放到 {width}×{height} / {fps}fps，居中裁剪去黑边并重编码为
        平台友好规格，避免上传后被二次压缩降质。
      </p>

      {/* 导入区 */}
      <section
        className="mt-6 rounded-xl border p-5"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">导入视频</span>
          <span className="text-xs" style={{ color: "var(--ck-text-dim)" }}>
            共 {fileList.length} 个视频
          </span>
        </div>

        <div
          className="mt-3 flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm"
          style={{ borderColor: "var(--ck-border)", color: "var(--ck-text-dim)" }}
        >
          {fileList.length === 0 ? (
            <span>用下方按钮选择文件或文件夹</span>
          ) : (
            <ul className="max-h-44 w-full space-y-1 overflow-y-auto text-left">
              {fileList.map((f) => (
                <li
                  key={f.file}
                  className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs"
                  style={{ background: "var(--ck-surface-2)" }}
                >
                  <span className="truncate" title={f.file}>
                    {basename(f.file)}
                  </span>
                  <StatusBadge state={f} />
                </li>
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

      {/* 操作区 */}
      <section className="mt-4 flex items-center gap-3">
        <button
          onClick={onStart}
          disabled={running || fileList.length === 0}
          className="flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "var(--ck-accent)", color: "#06231f" }}
        >
          <Play size={16} />
          {running ? "转换中…" : "开始转换"}
        </button>
        <Btn
          onClick={() => outputDir && openInExplorer(outputDir)}
          icon={<FolderOpen size={16} />}
          disabled={!outputDir}
        >
          打开输出目录
        </Btn>
        {running || doneCount > 0 ? (
          <span className="text-xs" style={{ color: "var(--ck-text-dim)" }}>
            已完成 {doneCount}/{fileList.length}
          </span>
        ) : null}
      </section>

      {/* 参数区 */}
      <section
        className="mt-5 rounded-xl border p-5"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="mb-4 text-sm font-medium">转换参数</div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="目标帧率">
            <Select value={fps} onChange={(v) => setFps(Number(v))} options={[24, 30, 60]} />
          </Field>
          <Field label="CRF 画质（越小越清晰）">
            <NumberInput value={crf} min={14} max={30} onChange={setCrf} />
          </Field>
          <Field label="音频码率 (kbps)">
            <NumberInput value={audioBitrate} min={64} max={320} step={32} onChange={setAudioBitrate} />
          </Field>
          <Field label="编码速度 preset">
            <Select value={preset} onChange={(v) => setPreset(String(v))} options={PRESETS} />
          </Field>
          <Field label="并发数">
            <NumberInput value={concurrency} min={1} max={16} onChange={setConcurrency} />
          </Field>
          <Field label="文件名后缀">
            <TextInput value={suffix} onChange={setSuffix} />
          </Field>
        </div>
        <div className="mt-4">
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
            </div>
          </Field>
        </div>
      </section>
    </div>
  );
}

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function StatusBadge({ state }: { state: FileState }) {
  const map: Record<string, { text: string; color: string }> = {
    pending: { text: "等待", color: "var(--ck-text-dim)" },
    running: { text: `${state.percent}%`, color: "var(--ck-accent)" },
    done: { text: "完成", color: "var(--ck-accent)" },
    error: { text: "失败", color: "var(--ck-danger)" },
  };
  const s = map[state.status] ?? map.pending;
  return (
    <span className="shrink-0 font-medium" style={{ color: s.color }} title={state.message ?? ""}>
      {s.text}
    </span>
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
      className="flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors disabled:opacity-40"
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
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-md border px-3 py-2 text-sm outline-none"
      style={inputStyle}
    />
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border px-3 py-2 text-sm outline-none"
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
  options: (string | number)[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border px-3 py-2 text-sm outline-none"
      style={inputStyle}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
