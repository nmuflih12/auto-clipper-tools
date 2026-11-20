@echo off
rem Clipper launcher. Opens the GUI at http://127.0.0.1:5170 with the last campaign used.
rem Optional: start-clipper.bat --project "D:\path\to\campaign-folder"
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Menyiapkan environment Python pertama kali, tunggu sebentar...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python app.py %*
pause
