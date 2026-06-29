import { useMemo } from "react";
import {
  setLlmAssignment,
  type LlmConfig,
  type LlmTask,
  type ModelRef,
} from "../../lib/llm";

const INHERIT = "__inherit__";

function encode(ref: ModelRef): string {
  return `${ref.connId}::${ref.model}`;
}
function decode(v: string): ModelRef | null {
  if (v === INHERIT) return null;
  const i = v.indexOf("::");
  if (i < 0) return null;
  return { connId: v.slice(0, i), model: v.slice(i + 2) };
}

export default function ModelAssignmentTable({
  config,
  tasks,
  onChange,
}: {
  config: LlmConfig;
  tasks: LlmTask[];
  onChange: (c: LlmConfig) => void;
}) {
  // 所有「连接×模型」选项
  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const c of config.connections) {
      for (const m of c.models) {
        opts.push({ value: encode({ connId: c.id, model: m }), label: `${m}  ·  ${c.label}` });
      }
    }
    return opts;
  }, [config.connections]);

  // 按模块分组任务
  const groups = useMemo(() => {
    const map = new Map<string, { moduleLabel: string; tasks: LlmTask[] }>();
    for (const t of tasks) {
      if (!map.has(t.moduleId)) map.set(t.moduleId, { moduleLabel: t.moduleLabel, tasks: [] });
      map.get(t.moduleId)!.tasks.push(t);
    }
    return [...map.entries()];
  }, [tasks]);

  async function set(scope: string, v: string) {
    onChange(await setLlmAssignment(scope, decode(v)));
  }

  const noModels = options.length === 0;

  return (
    <div>
      <h3 className="text-sm font-semibold">模型指派</h3>
      <p className="mt-1 text-xs" style={{ color: "var(--ck-text-dim)" }}>
        回退顺序：任务 → 模块 → 全局默认。留「继承上级」即用上一级。
      </p>

      {noModels && (
        <p className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: "rgba(251,191,36,0.12)", color: "#fbbf24" }}>
          还没有可用模型。请先在上方添加连接并「测试」拉取模型列表。
        </p>
      )}

      {/* 全局默认 */}
      <Row
        label="全局默认"
        sub="所有功能的兜底模型"
        value={config.assignments.global ? encode(config.assignments.global) : INHERIT}
        inheritLabel="（未设置）"
        options={options}
        disabled={noModels}
        onChange={(v) => set("global", v)}
      />

      {groups.map(([moduleId, g]) => {
        const moduleOverride = config.assignments.overrides[moduleId];
        return (
          <div key={moduleId} className="mt-3 rounded-lg border p-2" style={{ borderColor: "var(--ck-border)" }}>
            <Row
              label={g.moduleLabel}
              sub="模块默认（覆盖全局）"
              bold
              value={moduleOverride ? encode(moduleOverride) : INHERIT}
              inheritLabel="继承全局"
              options={options}
              disabled={noModels}
              onChange={(v) => set(moduleId, v)}
            />
            {g.tasks.map((t) => {
              const ov = config.assignments.overrides[t.id];
              return (
                <Row
                  key={t.id}
                  label={t.label}
                  sub={t.needsVision ? "需读图" : undefined}
                  indent
                  value={ov ? encode(ov) : INHERIT}
                  inheritLabel="继承模块"
                  options={options}
                  disabled={noModels}
                  onChange={(v) => set(t.id, v)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Row({
  label, sub, value, inheritLabel, options, onChange, indent, bold, disabled,
}: {
  label: string;
  sub?: string;
  value: string;
  inheritLabel: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  indent?: boolean;
  bold?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5" style={{ paddingLeft: indent ? 16 : 0 }}>
      <div className="min-w-0 flex-1">
        <div className={"truncate text-xs " + (bold ? "font-medium" : "")}>{label}</div>
        {sub && <div className="text-[10px]" style={{ color: "var(--ck-text-dim)" }}>{sub}</div>}
      </div>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 rounded-md border px-2 py-1 text-xs outline-none disabled:opacity-50"
        style={{ background: "var(--ck-surface-2)", borderColor: "var(--ck-border)", color: "var(--ck-text)" }}
      >
        <option value={INHERIT}>{inheritLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
