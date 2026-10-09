@echo off
cd /d "%~dp0\.."
for %%f in (images\*.tar.gz images\*.tar) do docker load -i "%%f"
if not "%~1"=="" for %%a in (main edge bot encoder) do (docker tag vn-%%a:latest %~1/vn-%%a:latest && docker push %~1/vn-%%a:latest)
