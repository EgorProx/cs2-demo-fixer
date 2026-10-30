@echo off
setlocal enableextensions
chcp 65001 >nul

if not "%~1"=="" goto run

echo Drag one or more .dem / .dem.zst / .dem.gz files onto this file.
echo Or run: node cli.js "demo.dem"
goto done

:run
:loop
if "%~1"=="" goto done
node "%~dp0cli.js" "%~1"
if errorlevel 1 echo [failed] %~1
shift
goto loop

:done
if not defined DEMOFIX_NOPAUSE pause
endlocal
