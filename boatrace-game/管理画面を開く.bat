@echo off
chcp 65001 > nul
cd /d "%~dp0"
REM Edge(Windows標準)で管理画面を開きます。Chromeを使う場合は msedge を chrome に変えてください
start "" msedge "%~dp0admin.html"
