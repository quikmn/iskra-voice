# Stops Windows Firewall "allow this app?" prompts for Iskra's dev and test binaries.
# Every new path to livekit-server.exe, iskra-server.exe or electron.exe that listens on the network asks again;
# this adds an inbound *block* rule for each one (tests only use localhost, which the firewall doesn't filter).
# Needs an elevated shell. Safe to re-run: it replaces the rules it made before.
# Usage: scripts/dev-firewall.ps1 [-Roots D:\path\to\Iskra, ...]
param([string[]]$Roots = @((Resolve-Path "$PSScriptRoot\..").Path) + @(Get-ChildItem "$PSScriptRoot\..\..\Iskra-wt" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName))

$group = 'Iskra dev binaries'
Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$names = 'livekit-server.exe', 'iskra-server.exe', 'iskra-p2p.exe', 'electron.exe', 'Iskra.exe', 'pebble.exe'
$places = '.tools', 'server\src\Iskra.Server\bin', 'desktop\build', 'desktop\release', 'desktop\node_modules\electron\dist', 'client\node_modules\electron\dist', '.dev'
$count = 0
foreach ($root in $Roots) {
    foreach ($place in $places) {
        $dir = Join-Path $root $place
        if (-not (Test-Path $dir)) { continue }
        Get-ChildItem $dir -Recurse -File -Include $names -ErrorAction SilentlyContinue | ForEach-Object {
            New-NetFirewallRule -DisplayName "Iskra dev: $($_.Name) ($($_.Directory.FullName))" -Group $group `
                -Direction Inbound -Action Block -Program $_.FullName -Profile Any | Out-Null
            $count++
        }
    }
}
Write-Host "Added $count rules ($group)."
