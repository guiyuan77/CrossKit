# CrossKit 发版规范

> 仓库：`guiyuan77/CrossKit` · CI：`.github/workflows/release.yml` · 应用内更新：`latest.json`

本文档约定**从改版本号到 GitHub Release 自动出包**的通用流程。系统设计文档在本地 `docs/`，不入库；发版相关说明放在 `.github/`，随源码一起维护。

---

## 1. 版本号规则（SemVer）

格式：`主版本.次版本.修订号`（如 `0.3.0`），Git tag 带前缀 **`v`**（如 `v0.3.0`）。

|  bump | 何时使用 | 示例 |
|---|---|---|
| **修订号 +1**（`0.3.0 → 0.3.1`） | 修 bug、小优化、文案/样式微调；无新模块 | 修复外链复制失败 |
| **次版本 +1**（`0.3.0 → 0.4.0`） | 新增功能模块或明显新能力；向后兼容 | 新增 LLM 网关、对标拆解器 |
| **主版本 +1**（`0.x → 1.0.0`） | 破坏性变更、大改版、对外正式版 | 待定 |

**约束**

- 每个 tag **只能用一次**；已发布的 `v0.2.0` 不可覆盖。
- tag 名必须与三处应用版本**完全一致**（见 §2）。
- 未达 `1.0.0` 前，团队也可采用「每次发版 patch +1」的简化策略；发版前在 commit message 里写清 `bump x.y.z` 即可。

---

## 2. 发版前必须同步的版本号（三处）

以下三处**必须相同**，否则安装包版本与自动更新会对不上：

| 文件 | 字段 |
|---|---|
| `desktop-app/package.json` | `"version"` |
| `desktop-app/src-tauri/Cargo.toml` | `version =` |
| `desktop-app/src-tauri/tauri.conf.json` | `"version"` |

可选：`desktop-app/package-lock.json` 顶层 `"version"` 与上保持一致（`npm install` 会自动更新）。

---

## 3. 什么该进 Git、什么不该进

根目录 `.gitignore` 已约定：**只提交可构建的源代码**，以下内容**不要** commit：

- 本地/系统设计文档：`docs/`、`PROJECT_STATUS.md`、根目录 `README.md` 等
- 密钥与签名私钥：`*.env`、`*.key`、`*.key.pub`
- 构建产物：`node_modules/`、`target/`、`dist/`
- 本地工作目录：`runs/`、`inputs/`、`products/`
- 大体积 sidecar：`desktop-app/src-tauri/binaries/ffmpeg-*`（CI 自动下载）

发版前执行 `git status`，确认没有误加私密文件或大文件。

---

## 4. 标准发版流程（推荐）

### 4.1 本地验证

```bash
cd desktop-app/src-tauri
cargo check
cargo test

cd ../..
npm run build   # 或 npm run tauri dev 冒烟
```

### 4.2  bump 版本号

将 §2 三处改为目标版本（如 `0.3.1`）。

### 4.3 提交

```bash
git add .gitignore desktop-app/ .github/
git commit -m "feat: 简述本次变更; bump 0.3.1"
```

Commit message 风格（与历史一致）：

- `feat(...)` 新功能 · `fix(...)` 修复 · `ci(...)` 流水线 · `chore(...)` 杂项
- 末尾带 `bump x.y.z`

### 4.4 打 tag 并推送（触发 CI）

```bash
git tag v0.3.1
git push origin main
git push origin v0.3.1
```

**仅 push tag 也会触发构建**；建议 main 与 tag 一起推，保证 Release 对应最新 commit。

### 4.5 等待 GitHub Actions

- 工作流：**Actions → build-desktop-app**
- 触发条件：push `v*` tag，或手动 **workflow_dispatch**
- 成功后会自动：
  - 创建 GitHub **Release**（非草稿）
  - 上传 **Windows `.exe` 安装包**、**macOS `.dmg`**
  - 上传 **`latest.json`**（应用内更新器读取）

Release 页：`https://github.com/guiyuan77/CrossKit/releases`

---

## 5. CI 与自动更新依赖

### 5.1 仓库 Secrets（GitHub → Settings → Secrets）

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 更新包签名私钥（`tauri signer generate` 生成，**勿提交仓库**） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令；无口令可留空或不设 |

`GITHUB_TOKEN` 由 Actions 自动注入，workflow 已设 `contents: write`。

### 5.2 应用内更新配置

`desktop-app/src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/guiyuan77/CrossKit/releases/latest/download/latest.json"
    ]
  }
}
```

用户安装旧版后，应用会拉取 `latest.json` 提示更新。**只有带签名的 CI 构建**才能被旧客户端信任更新。

---

## 6. 发版检查清单（Checklist）

- [ ] 三处版本号一致
- [ ] `cargo check` / `cargo test` 通过
- [ ] 无 `.env`、`.key`、大视频、ffmpeg 二进制被 staged
- [ ] commit message 含 `bump x.y.z`
- [ ] tag 名为 `v` + 版本号，且远程不存在同名 tag
- [ ] push 后 Actions 全绿
- [ ] Release 页有 Win/mac 产物 + `latest.json`
- [ ] （可选）用上一版安装包装新版，验证应用内更新

---

## 7. 常见问题

**Q：tag 推了但 Actions 失败？**  
看 Actions 日志。常见原因：Rust 编译错误、macOS target 缺失、Secret 未配置导致签名失败。

**Q：能否改已发布的 Release？**  
不要 force-push 或删除已发布的 tag。应发新版本（如 `v0.3.2`）修复。

**Q：只想重打安装包、不改代码？**  
GitHub → Actions → build-desktop-app → Run workflow（workflow_dispatch）。注意：无新 tag 时不会自动 bump Release 版本，一般仍应走新 tag 发版。

**Q：本地文档要不要跟着发？**  
`docs/`、`PROJECT_STATUS.md` 等仅保留在本地；发版说明以本文档为准。

---

## 8. 版本历史（摘要）

| Tag | 要点 |
|---|---|
| v0.2.0 | 应用内自动更新（Tauri updater） |
| v0.3.0 | LLM 网关、对标拆解器、外链自动化、网关音频输入 |

（后续发版请在此表追加一行。）
