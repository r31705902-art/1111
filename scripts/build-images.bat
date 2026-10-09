@echo off
rem Сборка образов V_N на Windows (Docker Desktop). Аргумент: префикс реестра (необязательно), напр. ghcr.io/myname
cd /d "%~dp0\.."
set P=
if not "%~1"=="" set P=%~1/
for %%a in (main edge bot encoder) do docker build -f %%a/Dockerfile -t %P%vn-%%a:latest . || exit /b 1
if not exist images mkdir images
docker save -o images\vn-main-edge-bot.tar %P%vn-main:latest %P%vn-edge:latest %P%vn-bot:latest
docker save -o images\vn-encoder.tar %P%vn-encoder:latest
if not "%~1"=="" for %%a in (main edge bot encoder) do docker push %P%vn-%%a:latest
echo done: images\
