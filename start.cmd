@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo   ============================================
echo     Task Kanban - Mission Control
echo   ============================================
echo.

rem ===============================================================
rem  Resolve node.exe
rem
rem  This file must stay ASCII-only: cmd.exe parses .cmd with the
rem  OEM codepage, so non-ASCII bytes can corrupt the command stream.
rem
rem  Flat `if` + `goto` is used deliberately. Wrapping `set` inside
rem  a parenthesised block hides the variable from later lines,
rem  which previously produced an empty NODE_EXE and the confusing
rem  error: '""' is not recognized as an internal or external command
rem ===============================================================
set "NODE_EXE="

rem 1) PATH lookup
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)
if defined NODE_EXE goto :node_found

rem 2) explicit override (set KANBAN_NODE to a full path if yours is elsewhere)
if defined KANBAN_NODE if exist "%KANBAN_NODE%" set "NODE_EXE=%KANBAN_NODE%"
if defined NODE_EXE goto :node_found

rem 3) standard install locations
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :node_found
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto :node_found
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :node_found

rem 4) WorkBuddy bundled node.
rem    NOTE: path is built from %USERPROFILE% on purpose. Do NOT hardcode
rem    an absolute C:\Users\<name>\... path here - that leaks the author's
rem    user name into a public repo and breaks on every other machine.
set "WB_NODE=%USERPROFILE%\.workbuddy\binaries\node"
if exist "%WB_NODE%\current\node.exe" set "NODE_EXE=%WB_NODE%\current\node.exe"
if defined NODE_EXE goto :node_found
for /d %%d in ("%WB_NODE%\versions\*") do (
  if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
)
if defined NODE_EXE goto :node_found

echo   [ERROR] node.exe was not found.
echo.
echo   Install Node.js from https://nodejs.org
echo   or set KANBAN_NODE to the full path of your node.exe.
echo.
goto :hold

:node_found
echo   [1/5] locating node.exe ... OK
echo.

rem ===============================================================
rem  Put node's directory on PATH.
rem
rem  The Agent SDK spawns its CLI child process with a bare `node`
rem  command when no explicit runtime is given, and the CLI itself
rem  also spawns `node` when running dispatched jobs.  This machine
rem  has no node in the system PATH, so those children failed with:
rem      CLI process spawn error: spawn node ENOENT
rem  Prepending the directory fixes every such child process at once.
rem
rem  Flat `if` + `goto` only - never `set` inside a parenthesised
rem  block, or the value is invisible to later lines.
rem ===============================================================
set "NODE_DIR="
rem  %%~dpi yields the directory WITH a trailing backslash
for %%i in ("%NODE_EXE%") do set "NODE_DIR=%%~dpi"
if not defined NODE_DIR goto :path_ready
set "PATH=%NODE_DIR%;%PATH%"
echo   [i] node dir added to PATH: %NODE_DIR%
echo.

:path_ready
rem ===============================================================
echo   [2/5] checking dependencies ...
if not exist "node_modules\tsx\dist\cli.mjs" goto :missing_deps
if not exist "node_modules\vite\bin\vite.js" goto :missing_deps
echo         tsx  : ok
echo         vite : ok
echo.

rem ===============================================================
echo   [3/5] checking server entry ...
if not exist "server\index.ts" goto :missing_index
if not exist "server\scheduler.ts" goto :missing_scheduler
echo         server\index.ts     : ok
echo         server\scheduler.ts : ok
echo.

rem ===============================================================
rem [3.5/5] WorkBuddy CLI launcher check removed 2026-09-15:
rem the CLI --serve dispatch channel is retired (see 内部归档),
rem so whether that launcher exists no longer affects anything.

rem ===============================================================
echo   [4/5] resolving port (config/port.txt + installed extension manifest) ...
set "PORT_FILE=%TEMP%\kanban-port.current.txt"
if exist "%PORT_FILE%" del "%PORT_FILE%" >nul 2>nul
"%NODE_EXE%" "scripts\port-preflight.mjs"
if errorlevel 1 goto :hold
if not exist "%PORT_FILE%" goto :port_file_missing
set "PORT="
set /p PORT=<"%PORT_FILE%"
if not defined PORT goto :port_file_missing
echo         using port %PORT%
echo.
goto :port_resolved

:port_file_missing
echo         ERROR: port preflight produced no port file.
echo         expected: %PORT_FILE%
echo         run manually:  node scripts\port-preflight.mjs
echo.
goto :hold

:port_resolved

rem ===============================================================
echo   [5/5] checking frontend build ...
if exist "dist\index.html" goto :build_ok
echo         dist : missing, building now (this may take a minute) ...
echo.
call npx --no-install vite build
if errorlevel 1 goto :build_failed
echo.
goto :run_server

:build_ok
echo         dist : ok
echo.

rem ===============================================================
:run_server
echo   ============================================
echo     Starting server ...
echo   ============================================
echo.
echo   Open in browser:   http://localhost:%PORT%
echo.
echo   *** Keep this window open while using the kanban ***
echo.

rem ---------------------------------------------------------------
rem  Auto-open the browser once the server is actually listening.
rem
rem  The port is picked dynamically (3000, 3001, ... 3010), so the URL
rem  differs between runs.  The server itself runs in the FOREGROUND
rem  below and blocks, which means a plain `start` after it would never
rem  be reached.  So the waiting is delegated to a small helper that is
rem  spawned first: it polls /api/health and opens the resolved URL.
rem
rem  Turn it off with:   set KANBAN_NO_BROWSER=1
rem  (useful when scripting/automating the launcher)
rem ---------------------------------------------------------------
if defined KANBAN_NO_BROWSER goto :skip_browser
start "" /b "%NODE_EXE%" "scripts\open-browser.mjs" %PORT%

:skip_browser

"%NODE_EXE%" "node_modules\tsx\dist\cli.mjs" "server\index.ts"

echo.
echo   Server stopped.
echo.
goto :hold

rem ===============================================================
rem  Error branches
rem ===============================================================
:missing_deps
echo         [ERROR] dependencies missing
echo.
echo   Run this first:   npm install
echo.
goto :hold

:missing_index
echo         [ERROR] server\index.ts not found
echo.
echo   Make sure start.cmd sits in the project root -- the folder that contains
echo   server\ and src\.
echo.
goto :hold

:missing_scheduler
echo         [ERROR] server\scheduler.ts not found
echo.
echo   Make sure start.cmd sits in the project root -- the folder that contains
echo   server\ and src\.
echo.
goto :hold

rem :port_busy is dead code left from the old fixed-port attempt.
rem Port resolution now lives in scripts\port-preflight.mjs (see [4/5] above).
:port_busy
echo         port 3000 : IN USE
echo.
echo   Another program is using port 3000.
echo   The script above should have picked a free port instead;
echo   if you see this, run again or set PORT manually.
echo.
goto :hold

:build_failed
echo.
echo   [ERROR] frontend build failed. See messages above.
echo.
goto :hold

:hold
pause
endlocal
