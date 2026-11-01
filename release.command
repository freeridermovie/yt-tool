#!/bin/bash
# 新しい版を配信する（ダブルクリック、または ./release.command 1.2.0）
#   1. release.json と manifest.json の版数を上げる
#   2. 配布用の dist/yt-tool.zip を作る
#   3. GitHub に push して Release を作る → 配った人のツールが数時間以内に自動更新される
set -euo pipefail
cd "$(dirname "$0")"

CUR=$(python3 -c 'import json;print(json.load(open("release.json"))["version"])')
VER="${1:-}"
if [ -z "$VER" ]; then
  echo "今の版: $CUR"
  read -r -p "新しい版 (例: ${CUR%.*}.$(( ${CUR##*.} + 1 ))): " VER
fi
read -r -p "変更内容（配る人向けのメモ）: " NOTES

python3 - "$VER" <<'EOF'
import json, sys
ver = sys.argv[1]
for path in ("release.json", "extension/manifest.json"):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data["version"] = ver
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
EOF

rm -rf dist && mkdir dist
zip -qr dist/yt-tool.zip release.json requirements.txt install.sh uninstall.sh server extension \
  -x '*/__pycache__/*' '*.DS_Store'
echo "dist/yt-tool.zip を作成しました"

git add -A
git commit -qm "v$VER: $NOTES"
git tag "v$VER"
git push -q origin HEAD --tags
gh release create "v$VER" dist/yt-tool.zip --title "v$VER" --notes "$NOTES"
echo "✔ v$VER を配信しました"
