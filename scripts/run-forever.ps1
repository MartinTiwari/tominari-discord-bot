<#
  Supervisor for the Tominari bot.

  Keeps `node bot.js` alive: if the process exits for any reason it is started
  again, with a backoff that grows only when the bot dies immediately (a crash
  loop) and resets once it has stayed up for a while. Output goes to one log
  file per day under logs/, and logs older than $MaxLogAgeDays are pruned.

  Launched at logon by the "Tominari Bot" scheduled task. To run it by hand:
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-forever.ps1
#>

$ErrorActionPreference = 'Continue'

$Root          = Split-Path -Parent $PSScriptRoot
$LogDir        = Join-Path $Root 'logs'
$Node          = 'C:\Program Files\nodejs\node.exe'
$MaxLogAgeDays = 14
$MinUptimeSec  = 60        # ran at least this long => not a crash loop
$MaxDelaySec   = 300       # cap the backoff at 5 minutes

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $Root

function Get-LogPath {
    Join-Path $LogDir ("tominari-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
}

function Write-Supervisor($message) {
    $line = "[{0}] SUPERVISOR {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
    Add-Content -Path (Get-LogPath) -Value $line -Encoding utf8
}

if (-not (Test-Path $Node)) {
    Write-Supervisor "node.exe not found at $Node - aborting"
    exit 1
}

$delay = 5

while ($true) {
    # Housekeeping on each cycle: drop logs past the retention window.
    Get-ChildItem $LogDir -Filter 'tominari-*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$MaxLogAgeDays) } |
        Remove-Item -Force -ErrorAction SilentlyContinue

    $log = Get-LogPath
    Write-Supervisor "starting bot.js"
    $startedAt = Get-Date

    # cmd.exe does the append+merge redirection; PowerShell 5.1 mangles a native
    # command's stderr when you redirect it inside the pipeline.
    $cmdLine = '/c ""{0}" bot.js >> "{1}" 2>&1"' -f $Node, $log
    $proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine `
                          -WorkingDirectory $Root -WindowStyle Hidden -PassThru -Wait

    $uptime = [int]((Get-Date) - $startedAt).TotalSeconds
    Write-Supervisor ("bot.js exited (code {0}) after {1}s" -f $proc.ExitCode, $uptime)

    if ($uptime -ge $MinUptimeSec) {
        $delay = 5                                   # healthy run - reset backoff
    } else {
        $delay = [Math]::Min($delay * 2, $MaxDelaySec)
    }

    Write-Supervisor "restarting in ${delay}s"
    Start-Sleep -Seconds $delay
}
