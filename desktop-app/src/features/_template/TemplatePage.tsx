/*
  ── 新功能模板 ──
  想加一个新功能时：
  1. 复制 src/features/_template 整个文件夹，改成你的功能名（如 src/features/selection）。
  2. 把这个组件改成你的页面。
  3. 如需调用本地能力（命令行/文件等），在 src-tauri/src/features/ 加一个 Rust 模块，
     并在 src-tauri/src/lib.rs 的 invoke_handler 里注册命令；前端在 src/lib/ipc.ts 加一个 invoke 封装。
  4. 在 src/app/modules.tsx 的数组里加一项，指向你的页面。侧边栏会自动出现。
*/
export default function TemplatePage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-7">
      <h1 className="text-xl font-semibold">新功能模板</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--ck-text-dim)" }}>
        这是一个占位页面，演示如何新增功能模块。复制 <code>src/features/_template</code>{" "}
        文件夹即可开始开发你自己的功能。
      </p>

      <div
        className="mt-6 rounded-xl border p-6 text-sm"
        style={{ background: "var(--ck-surface)", borderColor: "var(--ck-border)" }}
      >
        <ol className="list-decimal space-y-2 pl-5" style={{ color: "var(--ck-text-dim)" }}>
          <li>复制本文件夹并改名为你的功能。</li>
          <li>在 src/app/modules.tsx 注册新模块。</li>
          <li>需要本地能力时，在 src-tauri 加 Rust 命令并注册。</li>
          <li>前端用 src/lib/ipc.ts 里的封装调用。</li>
        </ol>
      </div>
    </div>
  );
}
