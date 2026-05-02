# launch-servers.ps1
# Scans the servers\ directory and starts one Origin server process per world folder.
# A world folder is any subdirectory that contains a server.json file.
# Add a server: create a new folder under servers\ with a server.json inside it.
# Remove a server: delete its folder (or rename server.json to disable it).

$ServerExe  = Join-Path $PSScriptRoot "iskra_server\bin\Release\net8.0\iskra_server.exe"
$ServersDir = Join-Path $PSScriptRoot "servers"

if (-not (Test-Path $ServersDir)) {
    Write-Host "No servers\ directory found. Create it and add world folders to get started."
    exit 1
}

$worlds = Get-ChildItem $ServersDir -Directory | Where-Object { Test-Path "$($_.FullName)\server.json" }

if ($worlds.Count -eq 0) {
    Write-Host "No world folders found in servers\. Each world needs a server.json inside it."
    exit 1
}

foreach ($world in $worlds) {
    Write-Host "Starting: $($world.Name)"
    Start-Process -FilePath $ServerExe -ArgumentList "`"$($world.FullName)`"" -WindowStyle Normal
}

Write-Host "$($worlds.Count) server(s) launched."
