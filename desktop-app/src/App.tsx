import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { modules } from "./app/modules";
import UpdateChecker from "./features/updater/UpdateChecker";

export default function App() {
  const [activeId, setActiveId] = useState(modules[0]?.id);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const mainModules = modules.filter((m) => (m.group ?? "main") === "main");
  const bottomModules = modules.filter((m) => m.group === "bottom");

  const ActiveComponent = useMemo(
    () => modules.find((m) => m.id === activeId)?.component,
    [activeId],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* 侧边栏 */}
      <aside
        className="flex w-56 shrink-0 flex-col border-r"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <div className="flex items-center gap-2 px-5 py-5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-lg font-bold"
            style={{ background: "var(--ck-accent)", color: "#06231f" }}
          >
            C
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">CrossKit</div>
            <div className="text-xs" style={{ color: "var(--ck-text-dim)" }}>
              跨境工具箱
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {mainModules.map((m) => (
            <NavItem
              key={m.id}
              module={m}
              active={m.id === activeId}
              onClick={() => setActiveId(m.id)}
            />
          ))}
        </nav>

        <nav className="space-y-1 px-3 pb-4">
          {bottomModules.map((m) => (
            <NavItem
              key={m.id}
              module={m}
              active={m.id === activeId}
              onClick={() => setActiveId(m.id)}
            />
          ))}
          <div
            className="px-3 pt-3 text-center text-[11px]"
            style={{ color: "var(--ck-text-dim)" }}
          >
            CrossKit{version ? ` v${version}` : ""}
          </div>
        </nav>
      </aside>

      {/* 内容区 */}
      <main className="flex-1 overflow-y-auto" style={{ background: "var(--ck-bg)" }}>
        {ActiveComponent ? <ActiveComponent /> : null}
      </main>

      {/* 启动检查更新（有新版才弹窗） */}
      <UpdateChecker />
    </div>
  );
}

function NavItem({
  module,
  active,
  onClick,
}: {
  module: (typeof modules)[number];
  active: boolean;
  onClick: () => void;
}) {
  const Icon = module.icon;
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
      style={{
        background: active ? "var(--ck-surface-2)" : "transparent",
        color: active ? "var(--ck-text)" : "var(--ck-text-dim)",
      }}
    >
      <Icon size={18} />
      <span>{module.label}</span>
    </button>
  );
}
