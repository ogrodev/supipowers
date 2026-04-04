# Install supipowers locally from the current working tree.
# Usage:  powershell -ExecutionPolicy Bypass -File bin\local-install.ps1
#
# This creates a global symlink so both the `supipowers` CLI and
# the OMP extension resolve to your local source — no publish needed.
# Re-run after pulling new changes; the symlink stays valid.

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

# 4. Run the installer to deploy to OMP extension directory
Write-Host "-> Running installer to deploy extension..."
bun run "$ProjectDir\bin\install.ts"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: installer failed" -ForegroundColor Red
    exit 1
}

# 5. Show version
$pkg = Get-Content "$ProjectDir\package.json" -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "[OK] supipowers v$($pkg.version) installed locally (linked to $ProjectDir)" -ForegroundColor Green
Write-Host "  Any edits to src/ or skills/ take effect immediately - no rebuild needed."
