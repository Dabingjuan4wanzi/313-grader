@echo off
chcp 65001 >nul
title 313 判卷助手 - 本地服务
cd /d "%~dp0"

>nul 2>&1 where python || (
  echo 未检测到 Python。请先到 https://www.python.org/downloads/ 安装，
  echo 安装时务必勾选 "Add python.exe to PATH"，装完再双击本文件。
  pause
  exit /b 1
)

echo 正在启动 313 判卷本地服务...
echo 会自动打开浏览器。若要手机访问，请看窗口里打印的"手机访问"地址（需与电脑连同一 WiFi）。
echo 关闭本窗口即停止服务。
python server.py
pause