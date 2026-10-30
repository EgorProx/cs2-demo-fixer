@echo off
setlocal
cd /d "%~dp0"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Could not find csc.exe ^(.NET Framework 4.x^).
  exit /b 1
)

if not exist "dist" mkdir "dist"

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /out:"dist\cs2-demo-fixer.exe" "gui\Program.cs"
if errorlevel 1 exit /b 1

copy /y "demofix.js" "dist\demofix.js" >nul
copy /y "cli.js" "dist\cli.js" >nul
copy /y "fix-demo.cmd" "dist\fix-demo.cmd" >nul
copy /y "README.md" "dist\README.md" >nul
if exist "LICENSE" copy /y "LICENSE" "dist\LICENSE" >nul
if exist "docs" xcopy /e /i /y "docs" "dist\docs" >nul

echo Built dist\cs2-demo-fixer.exe
