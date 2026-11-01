"""自動アップデート

インストーラーで入れた環境（~/Library/Application Support/YouTubeTool）でだけ動く。
GitHub Releases の最新版 (yt-tool.zip) を定期的に確認し、新しければ app/ を入れ替えて
サーバーを再起動する。Chrome 拡張は /api/health の extension_version を見て自分で再読み込みする。
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx

APP_DIR = Path(__file__).resolve().parent.parent
INSTALL_DIR = APP_DIR.parent
RELEASE = json.loads((APP_DIR / "release.json").read_text(encoding="utf-8"))
VERSION: str = RELEASE["version"]
REPO: str = RELEASE.get("repo", "")
ENABLED = (INSTALL_DIR / ".installed").exists() and bool(REPO)
ASSET = "yt-tool.zip"
CHECK_INTERVAL = 6 * 3600

state = {"auto_update": ENABLED, "latest": None, "checked_at": None, "error": None}


def parse_version(v: str) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in v.lstrip("v").split("."))
    except ValueError:
        return (0,)


def extension_version() -> str | None:
    try:
        return json.loads((APP_DIR / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return None


def check_and_apply(is_busy) -> bool | None:
    """新しい版があれば入れ替えてサーバーを再起動する。最新なら False、保存中で後回しなら None"""
    r = httpx.get(
        f"https://api.github.com/repos/{REPO}/releases/latest",
        headers={"Accept": "application/vnd.github+json"}, timeout=20, follow_redirects=True,
    )
    r.raise_for_status()
    rel = r.json()
    latest = rel["tag_name"].lstrip("v")
    state.update(latest=latest, checked_at=time.time(), error=None)
    if parse_version(latest) <= parse_version(VERSION):
        return False
    if is_busy():
        return None  # 保存中は少し待ってからやり直す
    asset = next((a for a in rel.get("assets", []) if a["name"] == ASSET), None)
    if not asset:
        raise RuntimeError(f"リリース {latest} に {ASSET} がありません")

    data = httpx.get(asset["browser_download_url"], timeout=120, follow_redirects=True)
    data.raise_for_status()
    new_dir = INSTALL_DIR / "app.new"
    old_dir = INSTALL_DIR / "app.old"
    shutil.rmtree(new_dir, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(data.content)) as z:
        z.extractall(new_dir)  # zipfile は絶対パスや .. を取り除いて展開する
    new_release = json.loads((new_dir / "release.json").read_text(encoding="utf-8"))
    if new_release["version"] != latest or not (new_dir / "server" / "app.py").exists():
        shutil.rmtree(new_dir, ignore_errors=True)
        raise RuntimeError("ダウンロードした更新ファイルが不正です")

    old_req = (APP_DIR / "requirements.txt").read_text(encoding="utf-8")
    new_req = (new_dir / "requirements.txt").read_text(encoding="utf-8")
    if new_req != old_req:
        subprocess.run(
            [str(INSTALL_DIR / "bin" / "uv"), "pip", "install", "-q", "--python", sys.executable,
             "-r", str(new_dir / "requirements.txt")],
            check=True,
        )

    shutil.rmtree(old_dir, ignore_errors=True)
    APP_DIR.rename(old_dir)
    new_dir.rename(APP_DIR)
    shutil.rmtree(old_dir, ignore_errors=True)
    print(f"[update] {VERSION} → {latest} に更新しました。再起動します", flush=True)
    os._exit(0)  # launchd (KeepAlive) が新しい版で起動し直す


def start(is_busy) -> None:
    if not ENABLED:
        return

    def loop():
        time.sleep(15)
        while True:
            wait = CHECK_INTERVAL
            try:
                if check_and_apply(is_busy) is None:
                    wait = 600
            except Exception as e:  # noqa: BLE001
                state["error"] = str(e)
                print(f"[update] 確認に失敗: {e}", flush=True)
            time.sleep(wait)

    threading.Thread(target=loop, daemon=True).start()
