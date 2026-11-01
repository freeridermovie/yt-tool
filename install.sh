#!/bin/bash
# YouTube Tool インストーラー（Mac 用）
#   ターミナルに次の1行を貼り付けて実行:
#   curl -fsSL https://raw.githubusercontent.com/freeridermovie/yt-tool/main/install.sh | bash
#
# Python・ffmpeg などは全部このツール専用のフォルダに入れるので、Mac の他の設定には影響しません。
# 入る場所: ~/Library/Application Support/YouTubeTool
set -euo pipefail

# curl | bash で途中のコマンドが残りの行を読んでしまわないよう、全体を関数にしてから実行する
main() {

REPO="${YTT_REPO:-freeridermovie/yt-tool}"
DIR="$HOME/Library/Application Support/YouTubeTool"
LABEL="local.yttool.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=8765

say() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✖ %s\033[0m\n' "$1"; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "Mac 専用です"
case "$(uname -m)" in
  arm64) UV_ARCH=aarch64 ;;
  x86_64) UV_ARCH=x86_64 ;;
  *) fail "対応していない Mac です ($(uname -m))" ;;
esac

# 自分の Mac の開発用サーバーが動いている場合などは止める
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  fail "ポート $PORT を別のプログラムが使っています。start.command で起動したサーバーがあれば閉じてから、もう一度実行してください"
fi

mkdir -p "$DIR/bin" "$DIR/data" "$DIR/logs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "1/4 YouTube Tool をダウンロードしています"
if [ -n "${YTT_ZIP:-}" ]; then
  cp "$YTT_ZIP" "$TMP/yt-tool.zip"   # テスト用: 手元の zip から入れる
else
  [ -n "$REPO" ] || fail "配信元 (REPO) が設定されていません"
  curl -fsSL "https://github.com/$REPO/releases/latest/download/yt-tool.zip" -o "$TMP/yt-tool.zip"
fi
rm -rf "$DIR/app.new"
mkdir -p "$DIR/app.new"
unzip -q "$TMP/yt-tool.zip" -d "$DIR/app.new"
[ -f "$DIR/app.new/server/app.py" ] || fail "ダウンロードしたファイルが壊れています"
rm -rf "$DIR/app"
mv "$DIR/app.new" "$DIR/app"
touch "$DIR/.installed"   # 自動アップデートを有効にする印

say "2/4 Python と必要な部品を入れています（数分かかります）"
if [ ! -x "$DIR/bin/uv" ]; then
  curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$UV_ARCH-apple-darwin.tar.gz" -o "$TMP/uv.tgz"
  tar xzf "$TMP/uv.tgz" -C "$TMP"
  mv "$TMP/uv-$UV_ARCH-apple-darwin/uv" "$DIR/bin/uv"
fi
export UV_PYTHON_INSTALL_DIR="$DIR/python" UV_CACHE_DIR="$DIR/cache"
[ -x "$DIR/.venv/bin/python" ] || "$DIR/bin/uv" venv -q --python 3.12 "$DIR/.venv"
"$DIR/bin/uv" pip install -q --python "$DIR/.venv/bin/python" -r "$DIR/app/requirements.txt"

say "3/4 ログイン時に自動で起動するよう設定しています"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/.venv/bin/python</string>
    <string>$DIR/app/server/app.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>YTT_DATA_DIR</key><string>$DIR/data</string>
    <key>PATH</key><string>$DIR/.venv/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>UV_PYTHON_INSTALL_DIR</key><string>$DIR/python</string>
    <key>UV_CACHE_DIR</key><string>$DIR/cache</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/server.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || fail "サーバーが起動しませんでした。$DIR/logs/server.log を確認してください"

say "4/4 Chrome に拡張機能を追加します"
EXT="$DIR/app/extension"
if [ -n "${YTT_SKIP_CHROME:-}" ]; then
  EXT_MSG="（Chrome の手順は省略しました）"
elif [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "chrome://extensions" || true
  sleep 1
  open -R "$EXT/manifest.json"
  osascript <<'EOF' >/dev/null 2>&1 || true
display dialog "Chrome の拡張機能ページを開きました。あと2ステップです。

① 右上の「デベロッパー モード」をオン
② Finder に表示された「extension」フォルダを、Chrome の拡張機能ページにドラッグ＆ドロップ

そのあと YouTube を開けば使えます。（この作業は最初の1回だけ。以後の更新は自動です）" buttons {"OK"} default button "OK" with title "YouTube Tool"
EOF
  EXT_MSG="Chrome で「デベロッパー モード」をオンにして、Finder の extension フォルダを拡張機能ページへドラッグしてください"
else
  EXT_MSG="Google Chrome が見つかりません。Chrome を入れてから、もう一度このインストールを実行してください"
fi

printf '\n\033[32m✔ インストールが完了しました\033[0m\n'
echo "  ・$EXT_MSG"
echo "  ・保存したクリップ/音源: ~/Downloads/YouTubeTool"
echo "  ・新しい版は自動で入ります（Mac にログインしている間）"
echo "  ・アンインストール: bash \"$DIR/app/uninstall.sh\""
}

main "$@"
