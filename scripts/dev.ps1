param([switch]$Seed, [switch]$Production)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot
if (-not (Test-Path .venv/Scripts/python.exe)) { throw "Create .venv and install apps/api/requirements.txt first. See README.md." }
if ($Production -and -not (Test-Path apps/web/.next/BUILD_ID)) { throw "Run npm run build before using -Production." }
$env:CONTROL_DATA_DIR = Join-Path $repoRoot '.data'
New-Item -ItemType Directory -Force .data | Out-Null
# Random credentials remain in the current process environment; no secrets are printed.
if (-not $env:CONTROL_API_KEY) { $env:CONTROL_API_KEY = [guid]::NewGuid().ToString('N') }
if (-not $env:CONTROL_HUMAN_KEY) { $env:CONTROL_HUMAN_KEY = [guid]::NewGuid().ToString('N') }
$env:WORKSPACE_ROOT = Join-Path $repoRoot 'workspaces'
$env:API_INTERNAL_URL = 'http://127.0.0.1:8000'
Push-Location apps/api
try {
    & ../../.venv/Scripts/python.exe -m control.bootstrap
    if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
    if ($Seed) {
        & ../../.venv/Scripts/python.exe -m control.seed
        if ($LASTEXITCODE -ne 0) { throw "Seed failed" }
    }
} finally { Pop-Location }
$pythonPath = Join-Path $repoRoot '.venv/Scripts/python.exe'
$apiProcess = Start-Process -FilePath $pythonPath -ArgumentList '-m','uvicorn','control.main:app','--host','127.0.0.1','--port','8000' -WorkingDirectory (Join-Path $repoRoot 'apps/api') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $repoRoot '.data/api.out.log') -RedirectStandardError (Join-Path $repoRoot '.data/api.err.log')
try {
    Write-Host 'API: http://127.0.0.1:8000/docs'
    Write-Host 'UI: http://127.0.0.1:3000'
    if ($Production) { & npm.cmd run start -w apps/web -- --hostname 127.0.0.1 }
    else { & npm.cmd run dev }
} finally {
    if (-not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id }
}
