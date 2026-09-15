@echo off
setlocal
cd /d "%~dp0"

rem ===============================================================
rem  Startup diagnostics. Read-only: touches nothing, only reports.
rem
rem  Rules kept deliberately (see start.cmd for the long version):
rem    - ASCII only (cmd.exe parses .cmd with the OEM codepage)
rem    - CRLF line endings (LF breaks label jumps)
rem    - flat "if" + "goto", never "set" inside a parenthesised block
rem      (%VAR% is expanded when the block is parsed, so a value set
rem       inside it is invisible to lines after the block)
rem    - every exit path pauses, so the window never closes silently
rem  The node path is built from %USERPROFILE% - never hardcode an
rem  absolute C:\Users\<name>\... path (it leaks the author's user
rem  name and breaks on every other machine).
rem ===============================================================

echo ============================================
echo   Task Kanban - startup diagnostics
echo ============================================
echo.

echo [1] current directory:
echo     %CD%
echo.

echo [2] node lookup:
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)
if defined NODE_EXE goto :node_path
echo     not in PATH - checking override / standard locations ...

if defined KANBAN_NODE if exist "%KANBAN_NODE%" set "NODE_EXE=%KANBAN_NODE%"
if defined NODE_EXE goto :node_path
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :node_path
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto :node_path
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :node_path

set "WB_NODE=%USERPROFILE%\.workbuddy\binaries\node"
if exist "%WB_NODE%\current\node.exe" set "NODE_EXE=%WB_NODE%\current\node.exe"
if defined NODE_EXE goto :node_path
for /d %%d in ("%WB_NODE%\versions\*") do (
  if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
)
if defined NODE_EXE goto :node_path

echo     ERROR: no node.exe available.
echo     Install Node.js from https://nodejs.org
echo     or set KANBAN_NODE to the full path of your node.exe.
echo.
goto :hold

:node_path
echo     using: %NODE_EXE%
echo.

echo [3] tsx cli present:
if exist "node_modules\tsx\dist\cli.mjs" echo     yes
if not exist "node_modules\tsx\dist\cli.mjs" echo     NO  - run: npm install
echo.

echo [4] server entry present:
if exist "server\index.ts" echo     yes
if not exist "server\index.ts" echo     NO
echo.

echo [5] dist build present:
if exist "dist\index.html" echo     yes
if not exist "dist\index.html" echo     no  - will be built on first run
echo.

echo [6] configured port status:
rem Port lives in ONE place: config\port.txt (see scripts\port-preflight.mjs).
set "CHECK_PORT="
if exist "config\port.txt" set /p CHECK_PORT=<config\port.txt
if not defined CHECK_PORT set "CHECK_PORT=47831"
netstat -ano | findstr "LISTENING" | findstr ":%CHECK_PORT%" >nul 2>nul
if not errorlevel 1 echo     port %CHECK_PORT% : IN USE - normal if the board is already running
if errorlevel 1 echo     port %CHECK_PORT% : free
echo.

rem React hook-order guard: a hook placed after a top-level early return
rem triggers React error #310 and blanks the whole board (renders fine
rem in type-check, only fails at runtime), so check it here too.
echo [7] react hook order:
"%NODE_EXE%" "scripts\check-hook-order.mjs"
echo.

rem Host-read-only guard: the project rule is "never write WorkBuddy data",
rem and this was broken once before (a module that wrote the host automations
rem table), so scan for write statements against the host DB / host directory.
echo [8] host read-only boundary:
"%NODE_EXE%" "scripts\check-host-readonly.mjs"
echo.

rem Schedule-algorithm suites. The repeat scheduler does real date maths
rem (month-end overflow, week wrap-around, run-count caps, deadline edges)
rem and the countdown text has a "must show seconds under 1 minute" rule.
rem Both are pure functions, cheap to run, and cover exactly the kind of bug
rem that "looks right but runs wrong", so they run here too.
echo [9] repeat schedule cases:
"%NODE_EXE%" "node_modules\tsx\dist\cli.mjs" "scripts\verify-repeat.mjs"
echo.

echo [10] countdown text cases:
"%NODE_EXE%" "node_modules\tsx\dist\cli.mjs" "scripts\verify-countdown-text.mjs"
echo.
echo ============================================
echo   Diagnostics complete.
echo   If all checks above are OK, run start.cmd
echo ============================================
echo.

:hold
pause
endlocal
