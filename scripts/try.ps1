param(
  [string]$Magpie = $(if ($env:MAGPIE) { $env:MAGPIE } else { 'magpie' }),
  [switch]$MetadataOnly,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$MagpieArgs
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path $root ('.sandbox/' + [guid]::NewGuid().ToString())
$variables = @('HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','CODEX_HOME','APPDATA','LOCALAPPDATA')
$saved = @{}
foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
  foreach ($name in @('HOME','USERPROFILE')) { [Environment]::SetEnvironmentVariable($name, $sandbox, 'Process') }
  foreach ($pair in @(@('XDG_CONFIG_HOME','.config'),@('XDG_CACHE_HOME','.cache'),@('CODEX_HOME','.codex'),@('APPDATA','AppData/Roaming'),@('LOCALAPPDATA','AppData/Local'))) {
    New-Item -ItemType Directory -Force -Path (Join-Path $sandbox $pair[1]) | Out-Null
    [Environment]::SetEnvironmentVariable($pair[0], (Join-Path $sandbox $pair[1]), 'Process')
  }
  Write-Output "Sandbox: $sandbox"
  function Invoke-Magpie([string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($Magpie)
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    try {
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw "Magpie exited $($process.ExitCode)" }
    } finally { $process.Dispose() }
  }
  Invoke-Magpie @('plugin','add',$root)
  if ($MetadataOnly -or -not $MagpieArgs) { Invoke-Magpie @('plugin','--json') }
  else { Invoke-Magpie $MagpieArgs }
} finally {
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
