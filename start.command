#!/bin/zsh
# ダブルクリックでローカルサーバーを起動
cd "$(dirname "$0")"
echo "yt-dlp を更新中..."; .venv/bin/pip install -q -U yt-dlp >/dev/null 2>&1
exec .venv/bin/python server/app.py
