# YouTube Tool

YouTube 上で使う Chrome 拡張 + ローカルサーバー。

- **クリップ保存** … 動画ページで開始/終了を指定して MP4 で保存（画質指定可）
- **音源保存** … 区間 or 動画全体を MP3 / M4A / WAV で保存
- **登録チャンネルの仕分け** … YouTube API で登録チャンネルを取得し、自分で作ったグループに分類。グループごとの新着動画一覧も見られる

## 他の人に配る（Mac + Chrome）

### 受け取る人のインストール（最初の1回だけ）

ターミナル（アプリケーション → ユーティリティ → ターミナル）を開き、次の1行を貼り付けて Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/freeridermovie/yt-tool/main/install.sh | bash
```

- Python・ffmpeg など必要なものは全部 `~/Library/Application Support/YouTubeTool` に入ります（Homebrew などは不要）
- サーバーは Mac にログインすると自動で起動します（ターミナルを開いておく必要はありません）
- 最後に Chrome の拡張機能ページと Finder が開くので、「デベロッパー モード」をオン → `extension` フォルダをページへドラッグ
- 登録チャンネルは、YouTube のサイドバー「📂 グループ」の「登録チャンネルを読み込む」でページから読み取ります（Google Cloud の設定は不要）
- アンインストール: `bash ~/Library/Application\ Support/YouTubeTool/app/uninstall.sh`

ダブルクリックで開くインストーラーにしていないのは、Apple の有料登録なしで配ったアプリは「開発元を確認できない」とブロックされ、初心者には開き方が難しいためです。ターミナルの1行ならこの警告が出ません。

### アップデートの配り方（自分の Mac で）

`release.command` をダブルクリック → 新しい版数と変更メモを入力。
GitHub に Release が作られ、配った人のツールは 6 時間以内に自動で更新されます（保存中は終わるまで待ちます）。Chrome 拡張も自動で読み込み直されます。

初回だけ必要な準備: GitHub アカウント、`brew install gh` → `gh auth login`、公開リポジトリ `yt-tool` の作成。

自分の Mac（このフォルダ）は開発用なので自動更新されません。Safari 版は自分用です（他の人に配るには Apple Developer Program が必要）。

---

```
yt-tool/
├── start.command     # ダブルクリックでサーバー起動
├── server/app.py     # ローカルサーバー (127.0.0.1:8765)
├── extension/        # Chrome 拡張
├── install.sh / uninstall.sh  # 配布用インストーラー
├── release.command   # 新しい版を配信
├── release.json      # 版数と配信元リポジトリ
├── client_secret.json  # ← 自分で配置 (YouTube API 用。配布物には含めない)
└── data/             # ログイン情報・登録チャンネル・グループ (自動作成)
```

保存先は既定で `~/Downloads/YouTubeTool/clips` と `~/Downloads/YouTubeTool/audio`（仕分け画面の「保存先フォルダ」で変更可）。

## 1. サーバーを起動

`start.command` をダブルクリック（初回に「開発元を確認できない」と出たら右クリック →「開く」）。
ターミナルが開いている間だけ動きます。起動時に yt-dlp を自動更新します。

再セットアップが必要な場合:

```bash
cd ~/Downloads/video-auto/yt-tool && /opt/homebrew/bin/python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

ffmpeg が必要です（インストール済み）。

## 2. Chrome 拡張を読み込む

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」→ `yt-tool/extension` フォルダを選択

YouTube の動画ページを開くと、プレーヤーの下に「✂ YT Tool」パネルが出ます。

- ⏱ ボタンで現在の再生位置を開始/終了に入れる（`1:23` や `1:02:03` と手入力も可）
- 「▶ 区間再生」で範囲を確認
- 開始/終了が空なら動画全体を保存

## 2'. Safari で使う場合

Safari 版は `safari/` の Xcode プロジェクトで、中身は Chrome 版と同じ `extension/` フォルダを参照しています。

1. `build-safari.command` をダブルクリック（ビルドして `~/Applications/YouTube Tool.app` に入れ、起動します。初回分はインストール済み）
2. 「設定」→「機能拡張」で「YouTube Tool」にチェック
3. 同じ画面の「Webサイトへのアクセス」で `youtube.com` と `127.0.0.1` を「許可」にする

Apple ID（Personal Team: `AS2P9LW44Y`）で署名してビルドするので、「未署名の機能拡張を許可」は不要です。
無料の Personal Team の署名は期限があるため、Safari に出てこなくなったら `build-safari.command` を再実行してください。

`extension/` のファイルを変更したら、`build-safari.command` を再実行すると Safari 版にも反映されます。
`extension/` に**新しいファイルを追加**したときは、`safari/YouTube Tool/YouTube Tool.xcodeproj/project.xcproj` の `content.js` の行をまねて1行追加してください（追加しないと Safari 版に含まれません）。

## 3. YouTube API の準備（登録チャンネル仕分け用・初回のみ）

1. https://console.cloud.google.com/ で新しいプロジェクトを作成
2. 「API とサービス」→「ライブラリ」で **YouTube Data API v3** を有効化
3. 「OAuth 同意画面」（Google Auth Platform）を設定
   - User Type: 外部 / アプリ名・メールは任意
   - 「対象」→ テストユーザーに自分の Google アカウントを追加
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - アプリケーションの種類: **デスクトップ アプリ**
5. 作成後に JSON をダウンロードし、`yt-tool/client_secret.json` という名前で置く
6. 拡張アイコン →「登録チャンネル仕分けを開く」→「Googleでログイン」

※ テスト中のアプリは「このアプリは Google で確認されていません」と出ますが、自分で作ったものなので「続行」で進めて OK。
※ 権限は読み取り専用（`youtube.readonly`）です。仕分けはこのツール内だけの分類で、YouTube 側の登録には影響しません。

### 仕分けの使い方（YouTube のページ上で完結）

YouTube の左サイドバー、「登録チャンネル」の上に「📂 グループ」が出ます。

- **ログイン**: 初回はグループ欄の「Googleでログイン」を押して許可
- **グループ作成**: 「＋」→ 名前を入力して Enter
- **チャンネルを追加/外す**: サイドバーや動画の投稿者名など、チャンネルのリンクを**右クリック** → グループにチェック。メニューから新しいグループを作ってそのまま追加も可
  - チャンネルをグループ名へ**ドラッグ**しても追加できます
  - 通常の右クリックメニューを出したいときは Shift+右クリック
- **グループの編集**: グループ名を右クリック → 名前変更・色・並べ替え・削除
- **新着動画**: グループ名にマウスを乗せて「新着」→ そのグループの最新動画をまとめて表示（RSS を使うので API の使用量は消費しません）
- **一覧の更新**: チャンネルを新しく登録したら「↻」
- 「⚙」で一覧表示の仕分け画面も開けます（まとめて大量に仕分けたいとき向け）

## 注意

- ダウンロードは個人利用の範囲で。YouTube 利用規約・著作権に注意してください（自分の動画や許諾のあるもの向け）。
- 保存に失敗するようになったら yt-dlp が古い可能性があります。サーバーを再起動すると自動更新されます。
  それでも一部の形式が取れない場合は `brew install deno` を入れると改善することがあります。
- サーバーは `127.0.0.1` のみで待ち受け、拡張機能と youtube.com 以外のサイトからのリクエストは拒否します。
