# SPDX-License-Identifier: GPL-3.0-or-later
# Installs hachidori-mpv into mpv's config folder (default: %APPDATA%\mpv).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -MpvDir D:\mpv\portable_config
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Release 0.3.1
param(
    [string]$MpvDir = (Join-Path $env:APPDATA "mpv"),
    [string]$Release = ""
)
$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 18 or newer is needed to install (https://nodejs.org). mpv does not need it afterwards." }
$major = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($major -lt 18) { throw "Node.js 18 or newer is needed; this is $(& node --version)." }

$source = Join-Path $PSScriptRoot "scripts\hachidori-mpv"
$scripts = Join-Path $MpvDir "scripts"
$target = Join-Path $scripts "hachidori-mpv"
$opts = Join-Path $MpvDir "script-opts"
New-Item -ItemType Directory -Force $scripts, $opts | Out-Null

$sameFolder = (Test-Path $target) -and ((Resolve-Path $target).Path -eq (Resolve-Path $source).Path -or
    (Get-Item $target).LinkType -eq "Junction")
if (-not $sameFolder) {
    Write-Host "Copying the plugin to $target"
    New-Item -ItemType Directory -Force $target | Out-Null
    robocopy $source $target /E /XD node_modules hachidori /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying failed (robocopy $LASTEXITCODE)." }
}

$conf = Join-Path $opts "hachidori-mpv.conf"
if (-not (Test-Path $conf)) {
    Copy-Item (Join-Path $PSScriptRoot "script-opts\hachidori-mpv.conf") $conf
    Write-Host "Wrote $conf"
} else {
    Write-Host "Kept your $conf"
}

$overlay = Join-Path $target "overlay"
Push-Location $overlay
try {
    Write-Host "Installing the overlay's packages..."
    & npm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    & node fetch-electron.mjs
    if ($LASTEXITCODE -ne 0) { throw "Downloading Electron failed." }
    if ($Release) { & node prepare-hachidori.mjs --release $Release } else { & node prepare-hachidori.mjs }
    if ($LASTEXITCODE -ne 0) { throw "Preparing Hachidori failed." }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "hachidori-mpv is installed. Open a video with Japanese subtitles in mpv;"
Write-Host "keep your browser's Hachidori (Settings -> Sharing) and Anki running."
