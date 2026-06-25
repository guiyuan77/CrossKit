# CrossKit 跨境工具箱

一个轻量、可分发给团队的本地桌面工具箱。首发功能：**视频批量转换**（内置 ffmpeg，把竖屏短视频统一成 1080×1920/30fps 的平台友好规格）。架构模块化，方便后续加新功能。

技术栈：Tauri 2（Rust 外壳）+ React + TypeScript + Vite + Tailwind v4。

---

## 一、底层实现的基本原理（先看这个）

```
┌─────────────────────────────────────────────┐
│  界面层（网页技术：React + TS）                 │
│  侧边栏 + 各功能页面，跑在系统自带的 WebView 里   │
└───────────────┬─────────────────────────────┘
                │  invoke 调用命令 / listen 监听事件
┌───────────────▼─────────────────────────────┐
│  外壳层（Rust，Tauri）                          │
│  注册命令、管理窗口、调用系统能力                  │
└───────────────┬─────────────────────────────┘
                │  调用内置二进制（sidecar）
┌───────────────▼─────────────────────────────┐
│  ffmpeg / ffprobe（随 App 一起打包）             │
└─────────────────────────────────────────────┘
```

几个关键概念：

- **为什么轻量**：Tauri 用操作系统自带的浏览器内核（Windows 的 WebView2 / macOS 的 WebView），不像 Electron 自带一整个 Chromium，所以包小、启动快、占内存少。
- **前端 ↔ 后端怎么通信**：前端用 `invoke("命令名", 参数)` 调用 Rust 写的命令；Rust 用 `emit("事件名", 数据)` 把进度等实时推给前端，前端用 `listen` 接收。封装都在 `src/lib/ipc.ts`。
- **ffmpeg 怎么来的**：作为 Tauri 的 “sidecar”（随程序打包的外部可执行文件）。运行时 Rust 调它来转码。同事装好就能用，不用自己装 ffmpeg。
- **转码原理**：先用 `ffprobe` 读视频总时长，再用 `ffmpeg` 按 `等比放大→居中裁剪→统一帧率→重编码(H.264/AAC)` 处理；通过 `-progress` 输出实时算出百分比推给界面。并发由 Rust 的信号量（Semaphore）控制（默认 5 个同时转）。

---

## 二、目录结构

```
desktop-app/
├── src/                         前端（界面）
│   ├── app/modules.tsx          ★功能模块注册中心（加功能改这里）
│   ├── features/
│   │   ├── transcode/           视频批量转换页（首发功能）
│   │   ├── settings/            设置页（演示本地存储）
│   │   └── _template/           ★新功能模板（复制它来加功能）
│   ├── lib/ipc.ts               ★前端调用后端的封装
│   ├── App.tsx                  整体布局（侧边栏+内容区）
│   └── index.css                主题配色
├── src-tauri/                   后端（Rust 外壳）
│   ├── src/lib.rs               ★命令注册中心（加命令改这里）
│   ├── src/features/
│   │   ├── mod.rs               模块声明
│   │   └── transcode.rs         转码逻辑（sidecar+并发+进度）
│   ├── binaries/                内置 ffmpeg/ffprobe（脚本下载，不进 git）
│   ├── capabilities/default.json 权限（允许调用 ffmpeg、文件框等）
│   └── tauri.conf.json          应用配置（名字、窗口、打包、sidecar）
├── scripts/fetch-ffmpeg.*       下载 ffmpeg 的脚本
└── .github/workflows/release.yml（在仓库根目录）双平台打包 CI
```

带 ★ 的是你后续最常改的文件。

---

## 三、本地开发前的环境准备（重要）

本机目前只有 Node，缺 **Rust** 和编译工具，必须先装好才能本地运行/打包：

1. **Rust**：装 rustup（https://rustup.rs），或 `winget install Rustlang.Rustup`。
2. **Windows C++ 构建工具**：安装 “Visual Studio Build Tools”，勾选 “使用 C++ 的桌面开发”。Tauri 在 Windows 上编译需要它。
3. **WebView2**：Win10/11 基本自带；缺失时装包会自动补。
4. **ffmpeg 二进制**：首次运行前执行 `npm run fetch:ffmpeg:win`（Mac 上是 `npm run fetch:ffmpeg:mac`），把 ffmpeg/ffprobe 下到 `src-tauri/binaries/`。

> 不想本机装 Rust 也行：直接用第六节的 GitHub Actions 云打包出安装包。但本地调试仍需要 Rust。

---

## 四、本地运行与开发

```bash
cd desktop-app
npm install                 # 装前端依赖（已装过可跳过）
npm run fetch:ffmpeg:win    # 下载内置 ffmpeg（首次）
npm run tauri dev           # 启动开发模式（带热更新）
```

只想看界面、不跑 Rust 时：`npm run dev` 仅启动网页部分（但调用后端的功能不可用）。

---

## 五、如何新增一个功能（按这个套路走）

以加一个「XX 工具」为例：

1. **复制模板**：把 `src/features/_template` 整个文件夹复制成 `src/features/xx`，把组件改成你的页面。
2. **注册到侧边栏**：在 `src/app/modules.tsx` 的数组里加一项：
   ```tsx
   { id: "xx", label: "XX 工具", icon: SomeIcon, component: XxPage, group: "main" }
   ```
   保存后侧边栏自动出现，无需改其它地方。
3. **（可选）需要本地能力时**（调命令行、读写文件等）：
   - 在 `src-tauri/src/features/` 新建 `xx.rs`，写一个 `#[tauri::command]` 函数；
   - 在 `src-tauri/src/features/mod.rs` 加 `pub mod xx;`；
   - 在 `src-tauri/src/lib.rs` 的 `generate_handler![...]` 里加上 `xx::你的命令`；
   - 在 `src/lib/ipc.ts` 加一个 `invoke("你的命令", ...)` 封装，页面里调用即可。
4. **（可选）要调新的外部程序/权限**：在 `src-tauri/capabilities/default.json` 里补对应权限。

记忆口诀：**前端加页面 → modules 注册；要本地能力 → Rust 加命令并在 lib.rs 注册 → ipc.ts 封装**。

---

## 六、打包与分发

### 本地打包（仅当前系统）
```bash
npm run tauri build
```
产物在 `src-tauri/target/release/bundle/`：Windows 是 `.exe`/`.msi`，macOS 是 `.dmg`。

### 推荐：GitHub Actions 云打包（Windows + Mac 一次出）
1. 把整个项目推到 GitHub。
2. 打一个 tag：`git tag v0.1.0 && git push --tags`。
3. Actions 会用 Windows 和 macOS(Apple 芯片) 两台云机器各打一个包，自动下载 ffmpeg，产物放到 Releases（草稿）。
4. 同事按系统下载：Windows 装 `.exe`，Mac 装 `.dmg`。

> CI 配置在仓库根目录 `.github/workflows/release.yml`。Mac 只出 Apple 芯片(arm64) 版（团队全是 Apple 芯片）。

---

## 七、你必须知道的注意事项

- **Mac 首次打开被拦（没花钱做签名）**：这是正常现象（系统提示“已损坏/身份不明开发者”，其实没问题）。让同事二选一解决，一次即可：
  - 终端跑：`xattr -cr /Applications/CrossKit.app`，之后双击正常打开；
  - 或：系统设置 → 隐私与安全性 → 点“仍要打开”。
  - 要做到双击零提示，需 Apple 开发者账号（约 \$99/年）做签名+公证，属后续优化。
- **Windows 首次打开 SmartScreen 提示**：点“更多信息 → 仍要运行”。买代码签名证书可消除，非必须。
- **ffmpeg 不进 git**：体积大，靠 `fetch-ffmpeg` 脚本下载；CI 打包时也会自动下。换电脑/重装后记得重跑一次。
- **下载源可能失效**：`scripts/fetch-ffmpeg.*` 里的默认下载链接若失效，可设环境变量 `CK_FFMPEG_URL` 覆盖成可用直链。
- **只做合规功能**：本工具只做本地视频转码等合规能力，不做截图里那种 token/cookie 抓取（封号与合规风险）。
- **改应用名/图标**：名字在 `tauri.conf.json` 的 `productName`；图标用 `npm run tauri icon 你的图.png` 生成。

---

## 八、与 UGC 工作流的关系

本工具补的是 `../UGC_WORKFLOW_SKILL.md` 里「Seedance 出片之后、上传 TikTok 之前」的转码环节，二者配合使用。
