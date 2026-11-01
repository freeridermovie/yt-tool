"""YouTube Tool ローカルサーバー

Chrome拡張から呼ばれ、以下を行う:
- 動画のクリップ保存 (MP4) / 音源保存 (MP3 / M4A / WAV)  … yt-dlp + ffmpeg
- YouTube Data API (OAuth) で登録チャンネルを取得
- 登録チャンネルのグループ仕分け (data/groups.json にローカル保存)
- グループごとの新着動画 (チャンネルRSS、APIクォータ消費なし)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
import updater  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# インストーラー版は app/ が更新で入れ替わるので、データはその外 (YTT_DATA_DIR) に置く
DATA_DIR = Path(os.environ.get("YTT_DATA_DIR") or ROOT / "data")
CLIENT_SECRET = ROOT / "client_secret.json"
TOKEN_FILE = DATA_DIR / "token.json"
SUBS_FILE = DATA_DIR / "subscriptions.json"
GROUPS_FILE = DATA_DIR / "groups.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]

DATA_DIR.mkdir(parents=True, exist_ok=True)


def ensure_tools() -> None:
    """ffmpeg / deno が PATH に無ければ、pip で入れた同梱版を使う"""
    bin_dir = Path(sys.executable).parent
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
    if shutil.which("ffmpeg"):
        return
    try:
        import imageio_ffmpeg
    except ImportError:
        return
    link = bin_dir / "ffmpeg"  # yt-dlp は「ffmpeg」という名前で探すのでリンクを張る
    link.unlink(missing_ok=True)
    link.symlink_to(imageio_ffmpeg.get_ffmpeg_exe())


ensure_tools()

ALLOWED_ORIGIN = re.compile(
    r"^(chrome-extension://.*|safari-web-extension://.*|https://www\.youtube\.com)$"
)

app = FastAPI(title="YouTube Tool")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN.pattern,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def block_foreign_sites(request, call_next):
    """他のWebサイトからこのサーバーを操作されないようにする"""
    origin = request.headers.get("origin")
    if origin and not ALLOWED_ORIGIN.match(origin):
        from fastapi.responses import JSONResponse

        return JSONResponse({"detail": "forbidden origin"}, status_code=403)
    return await call_next(request)


# ---------- 共通 ----------

def read_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def settings() -> dict:
    s = read_json(SETTINGS_FILE, {})
    s.setdefault("output_dir", str(Path.home() / "Downloads" / "YouTubeTool"))
    return s


def parse_time(value: str | float | None) -> float | None:
    """'1:23:45' / '83.5' / 83.5 → 秒"""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    parts = [float(p) for p in str(value).strip().split(":")]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return sec


def fmt_time(sec: float) -> str:
    sec = int(sec)
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "output_dir": settings()["output_dir"],
        "version": updater.VERSION,
        "extension_version": updater.extension_version(),
        **updater.state,
    }


class SettingsBody(BaseModel):
    output_dir: str


@app.put("/api/settings")
def put_settings(body: SettingsBody):
    path = Path(body.output_dir).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    s = settings()
    s["output_dir"] = str(path)
    write_json(SETTINGS_FILE, s)
    return s


# ---------- ダウンロード ----------

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=2)


class DownloadBody(BaseModel):
    url: str
    kind: str = "clip"          # "clip" (動画) | "audio" (音源)
    start: str | float | None = None
    end: str | float | None = None
    audio_format: str = "mp3"   # mp3 | m4a | wav
    quality: str = "1080"       # 動画の最大高さ: 2160 | 1440 | 1080 | 720 | 480


def update_job(job_id: str, **kw) -> None:
    with jobs_lock:
        jobs[job_id].update(kw)


def run_download(job_id: str, body: DownloadBody) -> None:
    start, end = parse_time(body.start), parse_time(body.end)
    sub = "clips" if body.kind == "clip" else "audio"
    out_dir = Path(settings()["output_dir"]) / sub
    out_dir.mkdir(parents=True, exist_ok=True)

    suffix = ""
    if start is not None or end is not None:
        suffix = f" [{fmt_time(start or 0)}-{fmt_time(end) if end else 'end'}]"

    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            pct = d.get("downloaded_bytes", 0) / total * 100 if total else None
            update_job(job_id, status="downloading", progress=pct)
        elif d["status"] == "finished":
            update_job(job_id, status="processing", progress=100)

    def pp_hook(d):
        if d["status"] == "finished" and d.get("info_dict", {}).get("filepath"):
            update_job(job_id, file=d["info_dict"]["filepath"])

    opts: dict = {
        "outtmpl": str(out_dir / f"%(title).150B{suffix} [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "windowsfilenames": True,
    }
    if start is not None or end is not None:
        opts["download_ranges"] = yt_dlp.utils.download_range_func(
            None, [(start or 0, end if end is not None else float("inf"))]
        )
        opts["force_keyframes_at_cuts"] = True

    if body.kind == "clip":
        h = int(body.quality) if body.quality.isdigit() else 1080
        opts["format"] = (
            f"bv*[height<={h}][ext=mp4]+ba[ext=m4a]/bv*[height<={h}]+ba/b[height<={h}]/b"
        )
        opts["merge_output_format"] = "mp4"
    else:
        fmt = body.audio_format if body.audio_format in ("mp3", "m4a", "wav") else "mp3"
        opts["format"] = "ba/b"
        opts["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": fmt, "preferredquality": "0"},
            {"key": "FFmpegMetadata"},
        ]

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(body.url, download=True)
            update_job(job_id, title=info.get("title"))
            if not jobs[job_id].get("file"):
                path = info.get("requested_downloads", [{}])[0].get("filepath")
                update_job(job_id, file=path)
        update_job(job_id, status="done", progress=100, finished_at=time.time())
    except Exception as e:  # noqa: BLE001
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
        update_job(job_id, status="error", error=msg, finished_at=time.time())


@app.post("/api/download")
def create_download(body: DownloadBody):
    start, end = parse_time(body.start), parse_time(body.end)
    if start is not None and end is not None and end <= start:
        raise HTTPException(400, "終了時間は開始時間より後にしてください")
    job_id = uuid.uuid4().hex[:10]
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id, "url": body.url, "kind": body.kind,
            "start": start, "end": end, "status": "queued", "progress": 0,
            "title": None, "file": None, "error": None, "created_at": time.time(),
        }
    executor.submit(run_download, job_id, body)
    return jobs[job_id]


@app.get("/api/jobs")
def list_jobs():
    with jobs_lock:
        return sorted(jobs.values(), key=lambda j: j["created_at"], reverse=True)[:30]


@app.post("/api/jobs/{job_id}/reveal")
def reveal(job_id: str):
    """Finderでファイルを表示"""
    import subprocess

    job = jobs.get(job_id)
    if not job or not job.get("file") or not Path(job["file"]).exists():
        raise HTTPException(404, "ファイルが見つかりません")
    subprocess.run(["open", "-R", job["file"]], check=False)
    return {"ok": True}


# ---------- 認証 (YouTube Data API) ----------

def load_credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if not TOKEN_FILE.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())
    return creds if creds.valid else None


@app.get("/api/auth/status")
def auth_status():
    return {
        "client_secret": CLIENT_SECRET.exists(),
        "logged_in": TOKEN_FILE.exists(),
    }


login_lock = threading.Lock()


@app.post("/api/auth/login")
def auth_login():
    """ブラウザでGoogleログインを開き、完了まで待つ"""
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CLIENT_SECRET.exists():
        raise HTTPException(400, f"{CLIENT_SECRET} がありません。READMEの手順で作成してください")
    if not login_lock.acquire(blocking=False):
        raise HTTPException(409, "ログイン処理中です。開いたブラウザのタブを確認してください")
    try:
        flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
        creds = flow.run_local_server(
            port=0, open_browser=True, timeout_seconds=300,
            success_message="ログインが完了しました。このタブは閉じて構いません。",
        )
        TOKEN_FILE.write_text(creds.to_json())
        return {"logged_in": True}
    finally:
        login_lock.release()


@app.post("/api/auth/logout")
def auth_logout():
    TOKEN_FILE.unlink(missing_ok=True)
    return {"logged_in": False}


# ---------- 登録チャンネル ----------

@app.get("/api/subscriptions")
def get_subscriptions():
    return read_json(SUBS_FILE, {"updated_at": None, "channels": []})


@app.post("/api/subscriptions/refresh")
def refresh_subscriptions():
    from googleapiclient.discovery import build

    creds = load_credentials()
    if not creds:
        raise HTTPException(401, "YouTubeにログインしてください")
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

    channels = []
    token = None
    while True:
        res = yt.subscriptions().list(
            part="snippet", mine=True, maxResults=50, pageToken=token, order="alphabetical"
        ).execute()
        for item in res.get("items", []):
            sn = item["snippet"]
            thumbs = sn.get("thumbnails", {})
            channels.append({
                "id": sn["resourceId"]["channelId"],
                "title": sn["title"],
                "description": sn.get("description", "")[:200],
                "thumbnail": (thumbs.get("default") or thumbs.get("medium") or {}).get("url"),
                "subscribed_at": sn.get("publishedAt"),
            })
        token = res.get("nextPageToken")
        if not token:
            break

    # YouTube のサイドバー等のリンクは /@handle 形式なので、ハンドルも取得しておく
    for i in range(0, len(channels), 50):
        batch = channels[i:i + 50]
        res = yt.channels().list(part="snippet", id=",".join(c["id"] for c in batch), maxResults=50).execute()
        handles = {it["id"]: it["snippet"].get("customUrl", "") for it in res.get("items", [])}
        for c in batch:
            c["handle"] = handles.get(c["id"], "").lower()

    data = {"updated_at": time.time(), "channels": channels}
    write_json(SUBS_FILE, data)
    return data


class ImportedChannel(BaseModel):
    id: str
    title: str
    thumbnail: str | None = None
    handle: str | None = None


class ImportBody(BaseModel):
    channels: list[ImportedChannel]


@app.post("/api/subscriptions/import")
def import_subscriptions(body: ImportBody):
    """API を使わない環境: 拡張機能が YouTube のページから読み取った登録チャンネルを保存する"""
    channels = [
        {"id": c.id, "title": c.title, "thumbnail": c.thumbnail, "handle": (c.handle or "").lower()}
        for c in body.channels if re.fullmatch(r"UC[\w-]{22}", c.id)
    ]
    data = {"updated_at": time.time(), "channels": channels, "source": "page"}
    write_json(SUBS_FILE, data)
    return data


# ---------- グループ仕分け ----------

class Group(BaseModel):
    id: str
    name: str
    color: str = "#888888"


class GroupsBody(BaseModel):
    groups: list[Group]
    assignments: dict[str, list[str]]   # channelId -> [groupId]


@app.get("/api/groups")
def get_groups():
    return read_json(GROUPS_FILE, {"groups": [], "assignments": {}})


@app.put("/api/groups")
def put_groups(body: GroupsBody):
    ids = {g.id for g in body.groups}
    assignments = {
        ch: [g for g in gs if g in ids] for ch, gs in body.assignments.items()
    }
    data = {
        "groups": [g.model_dump() for g in body.groups],
        "assignments": {ch: gs for ch, gs in assignments.items() if gs},
    }
    write_json(GROUPS_FILE, data)
    return data


# ---------- グループの新着動画 (RSS) ----------

ATOM = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
        "media": "http://search.yahoo.com/mrss/"}
feed_cache: dict[str, tuple[float, list]] = {}


def fetch_channel_feed(client: httpx.Client, channel_id: str) -> list[dict]:
    cached = feed_cache.get(channel_id)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    try:
        r = client.get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception:  # noqa: BLE001
        return []
    author = root.findtext("a:title", default="", namespaces=ATOM)
    videos = []
    for e in root.findall("a:entry", ATOM):
        vid = e.findtext("yt:videoId", namespaces=ATOM)
        link = e.find("a:link", ATOM)
        href = link.get("href") if link is not None else f"https://www.youtube.com/watch?v={vid}"
        videos.append({
            "id": vid,
            "title": e.findtext("a:title", namespaces=ATOM),
            "published": e.findtext("a:published", namespaces=ATOM),
            "url": href,
            "is_short": "/shorts/" in href,
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "channel_id": channel_id,
            "channel_title": author,
        })
    feed_cache[channel_id] = (time.time(), videos)
    return videos


@app.get("/api/feed")
def group_feed(group: str, limit: int = 60, shorts: bool = False):
    data = get_groups()
    if group == "__ungrouped__":
        subs = get_subscriptions()["channels"]
        channel_ids = [c["id"] for c in subs if not data["assignments"].get(c["id"])]
    else:
        channel_ids = [ch for ch, gs in data["assignments"].items() if group in gs]

    with httpx.Client(timeout=10, follow_redirects=True) as client:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = pool.map(lambda c: fetch_channel_feed(client, c), channel_ids)
            videos = [v for vs in results for v in vs]
    if not shorts:
        videos = [v for v in videos if not v["is_short"]]
    videos.sort(key=lambda v: v["published"] or "", reverse=True)
    return videos[:limit]


def downloads_running() -> bool:
    with jobs_lock:
        return any(j["status"] in ("queued", "downloading", "processing") for j in jobs.values())


if __name__ == "__main__":
    import uvicorn

    updater.start(downloads_running)
    uvicorn.run(app, host="127.0.0.1", port=8765)
