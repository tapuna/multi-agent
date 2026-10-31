param([switch]$Seed, [switch]$Production)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$runArgs = @('scripts/dev.mjs')
if ($Seed) { $runArgs += '--seed' }
if ($Production) { $runArgs += '--production' }
& node @runArgs
exit $LASTEXITCODE
