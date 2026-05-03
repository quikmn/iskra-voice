@echo off
:: launch-servers.bat
:: Scans servers\ and starts one Iskra server per world folder (any folder with server.json).
:: Add a server: create a folder under servers\ with a server.json inside.
:: Remove a server: delete the folder or rename server.json.

set EXE=%~dp0iskra_server\bin\Release\net8.0\iskra_server.exe

for /D %%d in ("%~dp0servers\*") do (
    if exist "%%d\server.json" (
        echo Starting: %%~nd
        start "%%~nd" "%EXE%" "%%d"
    )
)

echo Done.
