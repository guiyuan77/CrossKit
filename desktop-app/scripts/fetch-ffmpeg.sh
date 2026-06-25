#!/usr/bin/env bash
# 下载 macOS (Apple Silicon, arm64) 版 ffmpeg/ffprobe，放到 src-tauri/binaries。
# 用法：在 desktop-app 目录运行  ->  npm run fetch:ffmpeg:mac
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../src-tauri/binaries"
mkdir -p "$BIN"

# Apple Silicon 目标三元组（Tauri sidecar 命名规则）
TRIPLE="${CK_TRIPLE:-aarch64-apple-darwin}"

# 默认下载源（提供 macOS arm64 静态构建的 ffmpeg / ffprobe）。
# 如失效，可设置环境变量 CK_FFMPEG_URL / CK_FFPROBE_URL 覆盖为可用直链（zip 或裸二进制）。
FFMPEG_URL="${CK_FFMPEG_URL:-https://www.osxexperts.net/ffmpeg711arm.zip}"
FFPROBE_URL="${CK_FFPROBE_URL:-https://www.osxexperts.net/ffprobe711arm.zip}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_one() {
  local url="$1" outname="$2"
  echo "下载: $url"
  curl -L -o "$TMP/dl" "$url"
  if file "$TMP/dl" | grep -qi zip; then
    unzip -o "$TMP/dl" -d "$TMP/ex" >/dev/null
    # 取解压目录里第一个可执行二进制
    local bin
    bin="$(find "$TMP/ex" -type f \( -name "${outname%%-*}" -o -perm -u+x \) | head -n1)"
    cp "$bin" "$BIN/$outname"
  else
    cp "$TMP/dl" "$BIN/$outname"
  fi
  chmod +x "$BIN/$outname"
}

fetch_one "$FFMPEG_URL" "ffmpeg-$TRIPLE"
fetch_one "$FFPROBE_URL" "ffprobe-$TRIPLE"

echo "完成：已放置 ffmpeg-$TRIPLE / ffprobe-$TRIPLE 到 $BIN"
