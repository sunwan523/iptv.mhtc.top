param(
    [string]$Title = 'IPTV Source Alert',
    [string]$Message = 'One or more IPTV sources cannot play.',
    [int]$DurationSeconds = 8
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = $null
try {
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = [System.Drawing.SystemIcons]::Warning
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $notify.BalloonTipTitle = $Title
    $notify.BalloonTipText = $Message
    $notify.Visible = $true
    $notify.ShowBalloonTip(10000)
} catch {
}

try {
    [console]::beep(800, 400)
    [console]::beep(1000, 400)
} catch {
}

Start-Sleep -Seconds ([Math]::Max(1, $DurationSeconds))

try {
    if ($notify) {
        $notify.Visible = $false
        $notify.Dispose()
    }
} catch {
}
