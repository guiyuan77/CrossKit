# 下载 Windows 版 ffmpeg/ffprobe 并放到 src-tauri/binaries，按 Tauri 要求的命名（带目标三元组后缀）。
# 用法：在 desktop-app 目录运行  ->  npm run fetch:ffmpeg:win
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $here "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Windows x64 目标三元组（Tauri sidecar 命名规则）
$triple = if ($env:CK_TRIPLE) { $env:CK_TRIPLE } else { "x86_64-pc-windows-msvc" }
$url = if ($env:CK_FFMPEG_URL) { $env:CK_FFMPEG_URL } else { "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" }

$tmp = Join-Path $env:TEMP ("ffmpeg-dl-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "ffmpeg.zip"

Write-Host "下载 ffmpeg: $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Write-Host "解压中..."
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$ff = Get-ChildItem -Path $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$fp = Get-ChildItem -Path $tmp -Recurse -Filter ffprobe.exe | Select-Object -First 1
if (-not $ff -or -not $fp) { throw "压缩包里没找到 ffmpeg.exe/ffprobe.exe" }

Copy-Item $ff.FullName (Join-Path $binDir "ffmpeg-$triple.exe") -Force
Copy-Item $fp.FullName (Join-Path $binDir "ffprobe-$triple.exe") -Force
Remove-Item -Recurse -Force $tmp

Write-Host "完成：已放置 ffmpeg-$triple.exe / ffprobe-$triple.exe 到 $binDir"
