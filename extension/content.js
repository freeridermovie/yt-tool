// YouTube の動画ページにクリップ/音源保存パネルを追加する
(() => {
  const PANEL_ID = "ytt-panel";

  function api(path, method = "GET", body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "api", path, method, body }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error("ツールが更新されました。ページを再読み込みしてください"));
        res?.ok ? resolve(res.data) : reject(new Error(res?.error || "不明なエラー"));
      });
    });
  }

  const video = () => document.querySelector("#movie_player video, video.html5-main-video");

  function fmt(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function parse(str) {
    if (!str.trim()) return null;
    const parts = str.trim().split(":").map(Number);
    if (parts.some(isNaN)) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function currentUrl() {
    const id = new URLSearchParams(location.search).get("v");
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  }

  function buildPanel() {
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="ytt-row">
        <span class="ytt-logo">✂ YT Tool</span>
        <label>開始 <input class="ytt-time" data-k="start" placeholder="0:00"></label>
        <button class="ytt-btn ytt-now" data-k="start" title="再生位置を開始に">⏱</button>
        <label>終了 <input class="ytt-time" data-k="end" placeholder="最後"></label>
        <button class="ytt-btn ytt-now" data-k="end" title="再生位置を終了に">⏱</button>
        <button class="ytt-btn ytt-preview" title="区間をプレビュー再生">▶ 区間再生</button>
        <button class="ytt-btn ytt-clear" title="区間をクリア（動画全体）">クリア</button>
      </div>
      <div class="ytt-row">
        <select class="ytt-quality" title="画質">
          <option value="2160">4K</option><option value="1440">1440p</option>
          <option value="1080" selected>1080p</option><option value="720">720p</option><option value="480">480p</option>
        </select>
        <button class="ytt-btn ytt-primary" data-kind="clip">🎬 クリップ保存 (MP4)</button>
        <select class="ytt-afmt" title="音源形式">
          <option value="mp3">MP3</option><option value="m4a">M4A</option><option value="wav">WAV</option>
        </select>
        <button class="ytt-btn ytt-primary" data-kind="audio">🎵 音源保存</button>
      </div>
      <div class="ytt-status"></div>`;

    const input = (k) => el.querySelector(`.ytt-time[data-k="${k}"]`);
    const status = el.querySelector(".ytt-status");
    let previewTimer = null;

    el.querySelectorAll(".ytt-now").forEach((b) =>
      b.addEventListener("click", () => {
        const v = video();
        if (v) input(b.dataset.k).value = fmt(v.currentTime);
      }));

    el.querySelector(".ytt-clear").addEventListener("click", () => {
      input("start").value = "";
      input("end").value = "";
    });

    el.querySelector(".ytt-preview").addEventListener("click", () => {
      const v = video();
      const s = parse(input("start").value) ?? 0, e = parse(input("end").value);
      if (!v || isNaN(s)) return;
      v.currentTime = s;
      v.play();
      clearInterval(previewTimer);
      if (e && !isNaN(e)) {
        previewTimer = setInterval(() => {
          if (v.currentTime >= e) { v.pause(); clearInterval(previewTimer); }
        }, 100);
      }
    });

    el.querySelectorAll("[data-kind]").forEach((b) =>
      b.addEventListener("click", async () => {
        const url = currentUrl();
        const start = parse(input("start").value), end = parse(input("end").value);
        if (!url) return;
        if (Number.isNaN(start) || Number.isNaN(end)) {
          status.textContent = "⚠ 時間は 1:23 や 1:02:03 の形式で入力してください";
          return;
        }
        try {
          const job = await api("/api/download", "POST", {
            url, kind: b.dataset.kind, start, end,
            quality: el.querySelector(".ytt-quality").value,
            audio_format: el.querySelector(".ytt-afmt").value,
          });
          watchJob(job.id, status);
        } catch (err) {
          status.textContent = "⚠ " + err.message;
        }
      }));

    return el;
  }

  const watching = new Set();
  let polling = false;

  async function watchJob(id, status) {
    watching.add(id);
    if (polling) return;
    polling = true;
    const label = { queued: "待機中", downloading: "ダウンロード中", processing: "変換中" };
    while (watching.has(id)) {
      let jobs;
      try { jobs = await api("/api/jobs"); } catch (err) { status.textContent = "⚠ " + err.message; watching.clear(); break; }
      const active = jobs.filter((j) => watching.has(j.id));
      status.innerHTML = "";
      for (const j of active) {
        const line = document.createElement("div");
        const name = j.title || "取得中…";
        if (j.status === "done") {
          line.textContent = `✅ 保存しました: ${j.file?.split("/").pop() || name}`;
          watching.delete(j.id);
        } else if (j.status === "error") {
          line.textContent = `⚠ 失敗: ${j.error}`;
          watching.delete(j.id);
        } else {
          const pct = j.progress != null ? ` ${Math.round(j.progress)}%` : "";
          line.textContent = `⏳ ${j.kind === "clip" ? "クリップ" : "音源"} ${label[j.status] || j.status}${pct}`;
        }
        status.appendChild(line);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    polling = false;
  }

  function mount() {
    if (location.pathname !== "/watch") {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (document.getElementById(PANEL_ID)) return;
    const anchor = document.querySelector("#below ytd-watch-metadata") || document.querySelector("#below");
    if (!anchor) return;
    anchor.parentNode.insertBefore(buildPanel(), anchor);
  }

  // YouTubeはSPAなので遷移イベントとDOM変化の両方で設置を試みる
  document.addEventListener("yt-navigate-finish", () => {
    // 別の動画に移ったら区間をリセット
    document.querySelectorAll(`#${PANEL_ID} .ytt-time`).forEach((i) => (i.value = ""));
    setTimeout(mount, 300);
  });
  new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
  mount();
})();
