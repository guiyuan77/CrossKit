# binaries（内置 ffmpeg/ffprobe 放这里）

Tauri sidecar 要求二进制带「目标三元组」后缀命名：

- Windows x64：`ffmpeg-x86_64-pc-windows-msvc.exe`、`ffprobe-x86_64-pc-windows-msvc.exe`
- macOS Apple 芯片：`ffmpeg-aarch64-apple-darwin`、`ffprobe-aarch64-apple-darwin`

不要手动放，运行脚本自动下载并命名：

```bash
# Windows
npm run fetch:ffmpeg:win
# macOS
npm run fetch:ffmpeg:mac
```

这些文件不进 git（见 .gitignore），CI 打包时会自动下载。
