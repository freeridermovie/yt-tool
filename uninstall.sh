#!/bin/bash
# YouTube Tool をアンインストールする（保存したクリップ/音源は消えません）
DIR="$HOME/Library/Application Support/YouTubeTool"
LABEL="local.yttool.server"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
chmod -R u+w "$DIR" 2>/dev/null   # uv のキャッシュには読み取り専用のファイルがある
rm -rf "$DIR"
echo "アンインストールしました。Chrome の拡張機能ページ (chrome://extensions) から「YouTube Tool」も削除してください。"
