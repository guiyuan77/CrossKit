import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";

/*
  设置页：用 tauri-plugin-store 把配置存到用户配置目录的 settings.json。
  这里演示一个「默认输出后缀」的持久化设置，新功能可按需扩展。
*/
export default function SettingsPage() {
  const [defaultSuffix, setDefaultSuffix] = useState("_1080p");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    load("settings.json").then(async (store) => {
      const v = await store.get<string>("defaultSuffix");
      if (v) setDefaultSuffix(v);
    });
  }, []);

  async function onSave() {
    const store = await load("settings.json");
    await store.set("defaultSuffix", defaultSuffix);
    await store.save();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <h1 className="text-xl font-semibold">设置</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
        全局偏好设置，保存在本地配置文件中。
      </p>

      <div
        className="mt-6 rounded-xl border p-6"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <label className="block">
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
          className="mt-4 rounded-lg px-4 py-2 text-sm font-medium"
          style={{ background: "var(--ck-accent)", color: "#06231f" }}
        >
          {saved ? "已保存" : "保存"}
        </button>
      </div>
    </div>
  );
}
