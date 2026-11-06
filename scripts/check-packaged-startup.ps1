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
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HandsOffWindowIcon {
  [DllImport("user32.dll", EntryPoint="SendMessageW")]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("shell32.dll")]
  private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref PropVariant value);
  [StructLayout(LayoutKind.Sequential)]
  private struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)]
  private struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  public static string TaskbarProperty(IntPtr window, uint id) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref iid, out store));
    var key = new PropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = id };
    PropVariant value = new PropVariant();
    try {
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
      return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : null;
    } finally { PropVariantClear(ref value); Marshal.ReleaseComObject(store); }
  }
}
'@
function Compare-MascotIcon([System.Drawing.Icon]$Actual, [string]$Name) {
  $expected = [System.Drawing.Icon]::new((Join-Path $workspace 'build/app.ico'), $Actual.Width, $Actual.Height)
  $actualBitmap = $Actual.ToBitmap()
  $expectedBitmap = $expected.ToBitmap()
  try {
    if ($actualBitmap.Width -ne $expectedBitmap.Width -or $actualBitmap.Height -ne $expectedBitmap.Height) { return $false }
    [double]$difference = 0
    for ($y = 0; $y -lt $actualBitmap.Height; $y++) {
      for ($x = 0; $x -lt $actualBitmap.Width; $x++) {
        $a = $actualBitmap.GetPixel($x, $y); $b = $expectedBitmap.GetPixel($x, $y)
        $difference += [Math]::Abs([int]$a.R - [int]$b.R) + [Math]::Abs([int]$a.G - [int]$b.G) + [Math]::Abs([int]$a.B - [int]$b.B) + [Math]::Abs([int]$a.A - [int]$b.A)
      }
    }
    $actualBitmap.Save((Join-Path $workspace "artifacts/$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    return $difference / ($actualBitmap.Width * $actualBitmap.Height * 4) -lt 8
  } finally { $actualBitmap.Dispose(); $expectedBitmap.Dispose(); $expected.Dispose() }
}
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
  $appProcess = Get-Process | Where-Object {
    try { $_.MainWindowHandle -ne 0 -and ($_.Path -eq $unpackedExe -or $_.Path.StartsWith($portableTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) } catch { $false }
  } | Select-Object -First 1
  if (-not $appProcess) { throw 'Cannot find the isolated app window for icon verification.' }
  $iconHandle = [HandsOffWindowIcon]::SendMessage($appProcess.MainWindowHandle, 0x007F, [IntPtr]1, [IntPtr]0)
  if ($iconHandle -eq [IntPtr]0) { throw 'The app window has no explicit Windows icon.' }
  $windowIcon = ([System.Drawing.Icon]::FromHandle($iconHandle)).Clone()
  $executableIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($portableExe)
  $processIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($appProcess.Path)
  try {
    $report.windowIconMatchesMascot = Compare-MascotIcon $windowIcon 'taskbar-icon'
    $report.executableIconMatchesMascot = Compare-MascotIcon $executableIcon 'executable-icon'
    $report.processIconMatchesMascot = Compare-MascotIcon $processIcon 'process-icon'
  } finally { $windowIcon.Dispose(); $executableIcon.Dispose(); $processIcon.Dispose() }
  $report.taskbarIdentityMatches = [HandsOffWindowIcon]::TaskbarProperty($appProcess.MainWindowHandle, 5) -eq 'dev.agent.controltower.desktop'
  $report.taskbarDisplayNameMatches = [HandsOffWindowIcon]::TaskbarProperty($appProcess.MainWindowHandle, 4) -eq 'CW_Handsoff_sys'
  $expectedRelaunch = '"' + $executable + '" --user-data-dir="' + $profile + '"'
  $report.taskbarRelaunchMatches = [HandsOffWindowIcon]::TaskbarProperty($appProcess.MainWindowHandle, 2) -eq $expectedRelaunch
  $iconResource = [HandsOffWindowIcon]::TaskbarProperty($appProcess.MainWindowHandle, 3)
  $iconFile = if ($iconResource -match '^(.+),0$') { $Matches[1].Trim('"') } else { $null }
  $brandingFolder = (Join-Path $profile 'branding') + [IO.Path]::DirectorySeparatorChar
  $report.taskbarIconIsPersistent = $iconFile -and $iconFile.StartsWith($brandingFolder, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $iconFile) -and (Get-FileHash -LiteralPath $iconFile).Hash -eq (Get-FileHash -LiteralPath (Join-Path $workspace 'build/app.ico')).Hash
  $report.passed = $report.taskbarIdentityMatches -and $report.taskbarDisplayNameMatches -and $report.taskbarRelaunchMatches -and $report.taskbarIconIsPersistent -and $report.processIconMatchesMascot -and $report.windowIconMatchesMascot -and $report.executableIconMatchesMascot -and (-not $Portable -or $report.portablePayloadMatches) -and $report.rendererIPCInitialized -and -not $report.credentialVaultCopied -and $report.productVersion.StartsWith($version + '.')
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
