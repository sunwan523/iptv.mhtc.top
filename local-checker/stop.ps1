$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'IPTV checker is not running (no pid file)'
    exit 0
}

$processId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $processId -Force
    Write-Output ('Stopped IPTV checker, PID ' + $processId)
} else {
    Write-Output 'IPTV checker process already stopped'
}
Remove-Item -LiteralPath $pidFile -Force
