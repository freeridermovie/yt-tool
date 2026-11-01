#!/bin/zsh
# Safari版をビルドして ~/Applications にインストールする（extension/ を変更したら再実行）
cd "$(dirname "$0")/safari/YouTube Tool"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
TEAM="${1:-AS2P9LW44Y}"   # Apple ID のチームID。空文字を渡すと未署名ビルド
if [[ -n "$TEAM" ]]; then
  SIGN=(CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="Apple Development" -allowProvisioningUpdates)
else
  SIGN=(CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="")
fi
xcodebuild -project "YouTube Tool.xcodeproj" -scheme "YouTube Tool" -configuration Release \
  -derivedDataPath ../build "${SIGN[@]}" clean build | grep -E "error:|BUILD" || exit 1
mkdir -p ~/Applications
rm -rf ~/Applications/"YouTube Tool.app"
cp -R "../build/Build/Products/Release/YouTube Tool.app" ~/Applications/
# ビルド出力側が残るとSafariに2つ表示されるので削除
rm -rf "../build/Build/Products/Release/YouTube Tool.app"
open ~/Applications/"YouTube Tool.app"
echo "インストールしました。Safariの設定 → 機能拡張 で「YouTube Tool」をオンにしてください。"
