@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   DANG CAP NHAT CODE LEN GITHUB...
echo   Thu muc: %cd%
echo ============================================
echo.

REM Kiem tra co phai la git repo chua
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [LOI] Thu muc nay chua phai la git repository.
    echo Hay lam 1 lan duy nhat truoc, mo Command Prompt tai day va go:
    echo.
    echo   git init
    echo   git remote add origin https://github.com/TEN-BAN/TEN-REPO.git
    echo   git branch -M main
    echo   git add -A
    echo   git commit -m "Init"
    echo   git push -u origin main
    echo.
    pause
    exit /b 1
)

git add -A

set "msg="
set /p "msg=Nhap noi dung commit (Enter de dung mac dinh): "
if "%msg%"=="" (
    for /f "tokens=1-4 delims=/ " %%a in ("%date%") do set d=%%a-%%b-%%c
    set "msg=Cap nhat luc %date% %time%"
)

git commit -m "%msg%"

echo.
echo Dang day len GitHub...
git push

if errorlevel 1 (
    echo.
    echo ============================================
    echo   CO LOI KHI PUSH. Doc thong bao loi o tren.
    echo   (Thuong la do chua git remote, chua dang nhap,
    echo    hoac co xung dot voi ban tren GitHub.)
    echo ============================================
) else (
    echo.
    echo ============================================
    echo   XONG! Code da duoc cap nhat len GitHub.
    echo ============================================
)

echo.
pause
