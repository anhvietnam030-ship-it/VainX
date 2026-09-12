
@echo off
chcp 65001 >nul
title Vainglory Bot - Restart
cd /d "%~dp0"

echo ==========================================
echo   VAINGLORY BOT - RESTART
echo ==========================================
echo.

REM === Buoc 1: Backup file quan trong ===
echo [1/4] Dang backup file...
if exist index.js (
  copy /Y index.js index.js.bak >nul
  echo     - Da backup index.js
)
if exist src\rooms.js (
  copy /Y src\rooms.js src\rooms.js.bak >nul
  echo     - Da backup src\rooms.js
)
if exist src\rankSessions.js (
  copy /Y src\rankSessions.js src\rankSessions.js.bak >nul
  echo     - Da backup src\rankSessions.js
)
echo.

REM === Buoc 2: Kill bot cu ===
echo [2/4] Dang tat bot cu...
taskkill /F /IM node.exe >nul 2>&1
if %errorlevel%==0 (
  echo     - Da tat bot cu
) else (
  echo     - Khong co bot nao dang chay
)
timeout /t 2 /nobreak >nul
echo.

REM === Buoc 3: Check syntax ===
echo [3/4] Dang check syntax...
node -c index.js
if %errorlevel% neq 0 (
  echo.
  echo  ==========================================
  echo   LOI SYNTAX! Kiem tra lai index.js
  echo  ==========================================
  echo.
  pause
  exit /b 1
)
node -c src\rooms.js
if %errorlevel% neq 0 (
  echo  ==========================================
  echo   LOI SYNTAX! Kiem tra lai src\rooms.js
  echo  ==========================================
  echo.
  pause
  exit /b 1
)
node -c src\rankSessions.js
if %errorlevel% neq 0 (
  echo  ==========================================
  echo   LOI SYNTAX! Kiem tra lai src\rankSessions.js
  echo  ==========================================
  echo.
  pause
  exit /b 1
)
echo     - Syntax OK
echo.

REM === Buoc 4: Chay bot ===
echo [4/4] Dang chay bot...
echo ==========================================
echo.
node index.js

REM Neu bot thoat, hoi co muon chay lai
echo.
echo ==========================================
echo   Bot da tat. Bam phim bat ky de dong.
echo ==========================================
pause >nul