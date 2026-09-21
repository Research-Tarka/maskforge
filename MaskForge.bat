@echo off
REM Launches MaskForge in development mode: starts the Tauri shell, which
REM spawns the Python sidecar and opens the app window.
setlocal
cd /d "%~dp0"

REM PATH sometimes lags a fresh Node/Rust install until Windows re-reads the
REM registry (e.g. right after setup, before a reboot) — fall back to the
REM standard install location rather than failing outright.
where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
    )
)

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on PATH. Install it from nodejs.org, then re-run this launcher.
    echo If you just installed it, try closing and reopening this window first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing frontend dependencies, this only happens once...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

if not exist "sidecar\.venv" (
    echo Setting up the Python sidecar environment, this only happens once...
    python -m venv sidecar\.venv
    call sidecar\.venv\Scripts\pip install -e "sidecar[dev]"
    if errorlevel 1 (
        echo Sidecar setup failed.
        pause
        exit /b 1
    )
)

echo Starting MaskForge...
call npm run tauri dev

endlocal
