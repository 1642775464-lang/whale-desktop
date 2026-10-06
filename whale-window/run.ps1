<#
  小窗启动脚本（必用）

  职责：用仓库根共享的 Electron 起小窗。
  所属层：小窗（whale-window）

  为什么必须走这个脚本而不是直接双击 main.cjs：

  1. 启动**必须**带 --no-sandbox。开 Chromium 沙箱时 GUI 初始化会崩
     0x80000003，进程只活 15~20ms、连 main.cjs 的模块体都执行不到，
     表现成「双击没反应」（小窗 PRD 5.1）。

  2. **必须清掉 ELECTRON_RUN_AS_NODE**。DSH 宿主给子进程注入了它，
     Electron 二进制看到它就会退化成纯 node 模式，报
     `Cannot find module 'electron'`。而 PowerShell 的 Start-Process 与
     cmd 的 `set VAR=` 都清不掉它——只有在 .NET ProcessStartInfo 层面
     Environment.Remove() 才有效（小窗 PRD 5.3）。所以这里也删一次兜底。

  用法：
    .\run.ps1                      # 默认连 127.0.0.1:19387
    .\run.ps1 -Port 19500          # 连别的桥端口（联调用）
    .\run.ps1 -NoRestore           # 不读也不写窗口状态记忆（验收用）
#>

param(
  [int]$Port = 19387,
  [switch]$NoRestore
)

$ErrorActionPreference = "Stop"

# 注意：不要写 $args —— 它是 PowerShell 自动变量，赋值行为跨版本不一致（PRD 5.7）
$windowDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $windowDir
$electron = Join-Path $repoRoot "runtime\electron.exe"

if (-not (Test-Path $electron)) {
  throw "找不到 Electron 运行时：$electron。请先把官方 zip 离线解包到 runtime/（决策 D2：不联网下载）。"
}

$entry = Join-Path $windowDir "main.cjs"
if (-not (Test-Path $entry)) {
  throw "找不到小窗入口：$entry"
}

if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE
}

$env:WHALE_BRIDGE_PORT = "$Port"

$extra = @()
if ($NoRestore) { $extra += "--whale-no-restore" }

Write-Host "启动小窗：$electron --no-sandbox $entry（桥端口 $Port）"
& $electron --no-sandbox @extra $entry
