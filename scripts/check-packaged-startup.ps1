#Requires -Version 7.4
param([string]$OutputDirectory = 'release', [switch]$Portable)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = (Resolve-Path (Join-Path $workspace $OutputDirectory)).Path
$version = (Get-Content (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
$portableExe = Join-Path $output "CW_Handsoff_sys $version.exe"
$unpackedExe = Join-Path $output 'win-unpacked/CW_Handsoff_sys.exe'
$executable = if ($Portable) { $portableExe } else { $unpackedExe }
$profile = Join-Path $workspace ('artifacts/packaged-profile-' + [guid]::NewGuid().ToString())
$report = [ordered]@{ passed = $false; rendererIPCInitialized = $false; productVersion = (Get-Item -LiteralPath $unpackedExe).VersionInfo.ProductVersion; isolatedProfile = $true; credentialVaultCopied = $false; portableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $portableExe).Hash.ToLowerInvariant() }
$process = $null
$null = New-Item -ItemType Directory -Path $profile
try {
  $portableTemp = Join-Path $profile 'portable-temp'
  $null = New-Item -ItemType Directory -Path $portableTemp
  $process = Start-Process -Environment @{ TEMP=$portableTemp; TMP=$portableTemp } -FilePath $executable -ArgumentList ('--user-data-dir="' + $profile + '"') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(180)
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $profile 'startup-ready.json'))) {
    if ($process.HasExited) { throw 'Packaged app exited before renderer IPC initialization.' }
    Start-Sleep -Milliseconds 500
  }
  $report.rendererIPCInitialized = Test-Path -LiteralPath (Join-Path $profile 'startup-ready.json')
  if ($report.rendererIPCInitialized) {
    $ready = Get-Content -Raw -LiteralPath (Join-Path $profile 'startup-ready.json') | ConvertFrom-Json
    $report.mainVisible = $ready.mainVisible
    $report.splashClosed = $ready.splashClosed
    $report.startupPercent = $ready.percent
    $report.rendererIPCInitialized = $ready.mainVisible -and $ready.splashClosed -and $ready.percent -eq 100
  }
  $report.credentialVaultCopied = Test-Path -LiteralPath (Join-Path $profile 'vault.enc')
  if ($Portable) {
    $expected = (Get-FileHash -LiteralPath (Join-Path $output 'win-unpacked/resources/app.asar')).Hash
    $payload = Get-ChildItem -LiteralPath $portableTemp -Filter 'app.asar' -Recurse -File | Select-Object -First 1
    $report.portablePayloadMatches = $null -ne $payload -and (Get-FileHash -LiteralPath $payload.FullName).Hash -eq $expected
  }
  $report.passed = (-not $Portable -or $report.portablePayloadMatches) -and $report.rendererIPCInitialized -and -not $report.credentialVaultCopied -and $report.productVersion.StartsWith($version + '.')
} finally {
  try {
    if ($process -and -not $process.HasExited) {
      $null = $process.CloseMainWindow()
      if (-not $process.WaitForExit(1000)) {
        $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList @('/PID', [string]$process.Id, '/T', '/F') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $profile 'test-shutdown.txt') -RedirectStandardError (Join-Path $profile 'test-shutdown-errors.txt')
      }
    }
    if ($process) { $process.Refresh(); if (-not $process.HasExited) { $report.passed = $false } }
  } catch { $report.passed = $false; $report.shutdownError = $_.Exception.Message }
  $report.checkedAt = [DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $workspace 'artifacts/packaged-startup-v07.json')
}
$report | ConvertTo-Json
if (-not $report.passed) { exit 1 }
