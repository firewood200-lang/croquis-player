@echo off
echo ===================================
echo  Croquis Player - EXE 빌드 시작
echo ===================================
echo.

call npm install
if errorlevel 1 (
  echo [오류] npm install 실패
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  echo [오류] 빌드 실패
  pause
  exit /b 1
)

echo.
echo ===================================
echo  빌드 완료! dist 폴더를 확인하세요.
echo ===================================
pause
