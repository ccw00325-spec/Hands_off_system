$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$executable = Join-Path $workspace 'release/win-unpacked/CW_Handsoff_sys.exe'
$version = (Get-Content (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
$profile = Join-Path $workspace ('artifacts/packaged-profile-' + [guid]::NewGuid().ToString())
$report = [ordered]@{ passed = $false; rendererIPCInitialized = $false; productVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion; isolatedProfile = $true; credentialVaultCopied = $false; portableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $workspace "release/CW_Handsoff_sys $version.exe")).Hash.ToLowerInvariant() }
$process = $null
$null = New-Item -ItemType Directory -Path $profile
try {
  $process = Start-Process -FilePath $executable -ArgumentList ('--user-data-dir="' + $profile + '"') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $profile 'projects.json'))) {
    if ($process.HasExited) { throw 'Packaged app exited before renderer IPC initialization.' }
    Start-Sleep -Milliseconds 500
  }
  $report.rendererIPCInitialized = Test-Path -LiteralPath (Join-Path $profile 'projects.json')
  $report.credentialVaultCopied = Test-Path -LiteralPath (Join-Path $profile 'vault.enc')
  $report.passed = $report.rendererIPCInitialized -and -not $report.credentialVaultCopied -and $report.productVersion.StartsWith($version + '.')
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
