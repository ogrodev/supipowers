# Install supipowers locally from the current working tree.
# Usage:  powershell -ExecutionPolicy Bypass -File bin\local-install.ps1
#
# Creates a global symlink so `supipowers` CLI works, then runs the
# installer with --debug to deploy the extension and write a log file.
# Re-run after pulling new changes.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

Write-Host "-> Installing supipowers locally from $ProjectDir"

# 1. Install dependencies (fast no-op when lock is current)
Write-Host "-> Installing dependencies..."
Set-Location $ProjectDir
try {
    bun install --frozen-lockfile 2>$null
} catch {
    bun install
}

# 2. Create a global symlink via bun link
Write-Host "-> Linking supipowers globally..."
bun link
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: bun link failed" -ForegroundColor Red
    exit 1
}

# 3. Verify the link
$supiBin = Get-Command supipowers -ErrorAction SilentlyContinue
if ($supiBin) {
    Write-Host "[OK] 'supipowers' CLI is available at $($supiBin.Source)" -ForegroundColor Green
} else {
    Write-Host "[WARN] CLI not on PATH - you may need to add bun's global bin to PATH:" -ForegroundColor Yellow
    Write-Host "  `$env:PATH += `";$env:USERPROFILE\.bun\bin`""
}

# 4. Run the installer with --debug to deploy extension + write log
Write-Host "-> Running installer (--debug mode)..."
bun run "$ProjectDir\bin\install.ts" --debug
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: installer failed (check supipowers-install.log)" -ForegroundColor Red
    exit 1
}

# 5. Show version and log location
$pkg = Get-Content "$ProjectDir\package.json" -Raw | ConvertFrom-Json
$logFile = Join-Path $ProjectDir "supipowers-install.log"
Write-Host ""
Write-Host "[OK] supipowers v$($pkg.version) installed locally" -ForegroundColor Green
if (Test-Path $logFile) {
    Write-Host "  Debug log: $logFile" -ForegroundColor Cyan
}
