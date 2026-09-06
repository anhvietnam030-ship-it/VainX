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
if errorlevel 1 goto NOT_GIT_REPO

REM Canh bao neu dang co file bi mat (token/API key...) sap duoc commit, tranh lo len GitHub.
git status --porcelain | findstr /I /C:"Key.txt" /C:".env" >nul 2>&1
if errorlevel 1 goto NO_SECRET_FILE

echo ============================================
echo   CANH BAO: phat hien Key.txt hoac .env trong
echo   danh sach thay doi sap duoc dua len GitHub!
echo   Neu file nay chua Discord token hay API key,
echo   nhan Ctrl+C de DUNG LAI ngay, xoa file do
echo   khoi git ^(hoac them vao .gitignore^) roi chay lai.
echo ============================================
echo.
pause

:NO_SECRET_FILE
git add -A

set "msg="
set /p "msg=Nhap noi dung commit (Enter de dung mac dinh): "
if "%msg%"=="" set "msg=Cap nhat luc %date% %time%"

git commit -m "%msg%"

echo.
echo Dang tai code moi nhat tu GitHub ve truoc khi day len (git pull)...
git pull --rebase --autostash
if errorlevel 1 goto PULL_CONFLICT

echo.
echo Dang day len GitHub...
git push
if errorlevel 1 goto PUSH_FAILED
goto PUSH_OK

:NOT_GIT_REPO
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

:PULL_CONFLICT
echo.
echo ============================================
echo   CO XUNG DOT ^(CONFLICT^) KHI GOP CODE TU GITHUB.
echo   1. Mo cac file dang bi xung dot ^(git se liet ke^),
echo      sua phan nam giua ^<^<^<^<^<^<^< va ^>^>^>^>^>^>^>.
echo   2. Sau khi sua xong, go:
echo        git add .
echo        git rebase --continue
echo      roi chay lai file nay de day len GitHub.
echo   3. Neu muon huy, go: git rebase --abort
echo ============================================
echo.
pause
exit /b 1

:PUSH_FAILED
echo.
echo ============================================
echo   CO LOI KHI PUSH. Doc thong bao loi o tren.
echo   ^(Thuong la do chua git remote, chua dang nhap,
echo    hoac van con xung dot voi ban tren GitHub.^)
echo ============================================
goto END

:PUSH_OK
echo.
echo ============================================
echo   XONG! Code da duoc cap nhat len GitHub.
echo ============================================
goto END

:END
echo.
pause
