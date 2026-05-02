# launch-servers.ps1
# Starts one Origin server process per config file listed below.
# Each server uses its own working directory so chat logs stay separate.
# Run from the repo root, or adjust $RepoRoot below.

$RepoRoot  = $PSScriptRoot
$ServerExe = Join-Path $RepoRoot "iskra_server\bin\Release\net8.0\iskra_server.exe"

$Servers = @(
    @{ Config = "configs\bunker-alpha.json"; DataDir = "server-data\alpha" },
    @{ Config = "configs\bunker-beta.json";  DataDir = "server-data\beta"  }
)

foreach ($s in $Servers) {
    $configPath = Join-Path $RepoRoot $s.Config
    $dataDir    = Join-Path $RepoRoot $s.DataDir

    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

    $title = (Get-Content $configPath | ConvertFrom-Json).Settings.ServerName
    Write-Host "Starting: $title  (data: $dataDir)"

    Start-Process -FilePath $ServerExe `
                  -ArgumentList ('"' + $configPath + '"') `
                  -WorkingDirectory $dataDir `
                  -WindowStyle Normal
}

Write-Host "All servers launched."
