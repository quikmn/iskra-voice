@echo off
set EXE=%~dp0iskra_server\bin\Release\net8.0\iskra_server.exe
set WORLD=%~dp0servers\quikmn-main
start "quikmn-main" "%EXE%" "%WORLD%"
