@echo off
:: launch-servers.bat
:: Starts multiple Origin server instances, one per config.
:: Each gets its own data directory so chat logs stay separate.

set EXE=%~dp0iskra_server\bin\Release\net8.0\iskra_server.exe

:: ── Alpha ─────────────────────────────────────────────────────────────────────
set CFG_A=%~dp0configs\bunker-alpha.json
set DIR_A=%~dp0server-data\alpha
if not exist "%DIR_A%" mkdir "%DIR_A%"
start "Bunker Alpha" /D "%DIR_A%" "%EXE%" "%CFG_A%"

:: ── Beta ──────────────────────────────────────────────────────────────────────
set CFG_B=%~dp0configs\bunker-beta.json
set DIR_B=%~dp0server-data\beta
if not exist "%DIR_B%" mkdir "%DIR_B%"
start "Bunker Beta" /D "%DIR_B%" "%EXE%" "%CFG_B%"

echo All servers launched.
