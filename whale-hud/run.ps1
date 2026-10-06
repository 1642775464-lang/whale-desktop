<#
  悬浮条启动脚本（必用）

  职责：用仓库根共享的 Electron 起悬浮条。
  所属层：悬浮条（whale-hud）

  为什么必须走这个脚本而不是直接双击 main.cjs：
  启动**必须**带 --no-sandbox。开 Chromium 沙箱时 GUI 初始化会崩 0x80000003，
  进程只活 15~20ms、连 main.cjs 的模块体都执行不到，表现成「双击没反应」，
  看不到任何日志。实测只有 --no-sandbox 能越过去（PRD 5.1）。

  用法：
    .\run.ps1                  # 默认连 127.0.0.1:19387
    .\run.ps1 -Port 19391      # 连别的桥端口（联调用）
#>

param(
  [int]$Port = 19387
)

$ErrorActionPreference = "Stop"

$hudDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $hudDir
$electron = Join-Path $repoRoot "runtime\electron.exe"

if (-not (Test-Path $electron)) {
  throw "找不到 Electron 运行时：$electron。请先把官方 zip 离线解包到 runtime/（决策 D2：不联网下载）。"
}

$entry = Join-Path $hudDir "main.cjs"
if (-not (Test-Path $entry)) {
  throw "找不到悬浮条入口：$entry"
}

# 调试器上下文里 ELECTRON_RUN_AS_NODE 会被设置，那会让 Electron 以 Node 模式启动、
# 不显示任何窗口。必须在传下去之前删掉（开发规范强制 36 的同一条纪律）。
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE
}

$env:WHALE_BRIDGE_PORT = "$Port"

Write-Host "启动悬浮条：$electron --no-sandbox $entry（桥端口 $Port）"
& $electron --no-sandbox $entry
