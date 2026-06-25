# Download Windows ffmpeg/ffprobe into src-tauri/binaries with Tauri sidecar naming
# (target-triple suffix). Usage (run inside desktop-app):  npm run fetch:ffmpeg:win
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads scripts using the
# system ANSI codepage, so non-ASCII chars (e.g. Chinese) corrupt string parsing.
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $here "..\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Windows x64 target triple (Tauri sidecar naming convention)
$triple = if ($env:CK_TRIPLE) { $env:CK_TRIPLE } else { "x86_64-pc-windows-msvc" }
$url = if ($env:CK_FFMPEG_URL) { $env:CK_FFMPEG_URL } else { "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" }

$tmp = Join-Path $env:TEMP ("ffmpeg-dl-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "ffmpeg.zip"

Write-Host "Downloading ffmpeg: $url"
Invoke-WebRequest -Uri $url -OutFile $zip
Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$ff = Get-ChildItem -Path $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$fp = Get-ChildItem -Path $tmp -Recurse -Filter ffprobe.exe | Select-Object -First 1
if (-not $ff -or -not $fp) { throw "ffmpeg.exe/ffprobe.exe not found in archive" }

Copy-Item $ff.FullName (Join-Path $binDir "ffmpeg-$triple.exe") -Force
Copy-Item $fp.FullName (Join-Path $binDir "ffprobe-$triple.exe") -Force
Remove-Item -Recurse -Force $tmp

Write-Host "Done: placed ffmpeg-$triple.exe / ffprobe-$triple.exe into $binDir"
