param(
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $root 'server.js'
$stdout = Join-Path $root 'server.out.log'
$stderr = Join-Path $root 'server.err.log'
$pidFile = Join-Path $root 'server.pid'

if (Test-Path -LiteralPath $stdout) { Remove-Item -LiteralPath $stdout -Force }
if (Test-Path -LiteralPath $stderr) { Remove-Item -LiteralPath $stderr -Force }

$extra = ''
if ($NoOpen) { $extra = ' --no-open' }
$command = 'cmd /c ""' + $node + '" "' + $script + '"' + $extra + ' > "' + $stdout + '" 2> "' + $stderr + '""'

[void](New-Object -ComObject WScript.Shell).Run($command, 0, $false)

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $pidFile) { break }
}

if (Test-Path -LiteralPath $pidFile) {
    Write-Output ('IPTV checker started, PID ' + (Get-Content -LiteralPath $pidFile -Raw).Trim())
} else {
    Write-Output 'IPTV checker failed to start; check server.err.log'
}
