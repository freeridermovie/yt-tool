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

  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    scissors: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>'),
    film: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
    music: svg('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    play: svg('<path d="M7 5v14l11-7z" fill="currentColor"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  };

  function buildPanel() {
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.innerHTML = `
      <div class="ytt-bar">
        <span class="ytt-logo">${ICON.scissors}YT Tool</span>
        <div class="ytt-split ytt-split-primary">
          <button class="ytt-save" data-kind="clip">${ICON.film}<span>動画を保存</span></button>
          <select class="ytt-quality" title="画質">
            <option value="2160">4K</option><option value="1440">1440p</option>
            <option value="1080" selected>1080p</option><option value="720">720p</option><option value="480">480p</option>
          </select>
        </div>
        <div class="ytt-split">
          <button class="ytt-save" data-kind="audio">${ICON.music}<span>音声を保存</span></button>
          <select class="ytt-afmt" title="音声の形式">
            <option value="mp3">MP3</option><option value="m4a">M4A</option><option value="wav">WAV</option>
          </select>
        </div>
        <span class="ytt-spacer"></span>
        <button class="ytt-range-toggle" aria-expanded="false" title="動画の一部だけを保存する">${ICON.scissors}<span>区間を指定</span></button>
      </div>
      <div class="ytt-range" hidden>
        <label class="ytt-field"><span>開始</span><input class="ytt-time" data-k="start" placeholder="0:00">
          <button class="ytt-now" data-k="start" title="今の再生位置を入れる">${ICON.clock}</button></label>
        <span class="ytt-arrow">→</span>
        <label class="ytt-field"><span>終了</span><input class="ytt-time" data-k="end" placeholder="最後まで">
          <button class="ytt-now" data-k="end" title="今の再生位置を入れる">${ICON.clock}</button></label>
        <button class="ytt-ghost ytt-preview" title="指定した区間を再生して確認">${ICON.play}<span>確認</span></button>
        <span class="ytt-range-len"></span>
      </div>
      <div class="ytt-jobs"></div>`;

    const input = (k) => el.querySelector(`.ytt-time[data-k="${k}"]`);
    const range = el.querySelector(".ytt-range");
    const toggle = el.querySelector(".ytt-range-toggle");
    const lenLabel = el.querySelector(".ytt-range-len");
    const jobs = el.querySelector(".ytt-jobs");
    let previewTimer = null;

    function updateLen() {
      const s = parse(input("start").value) ?? 0, e = parse(input("end").value);
      lenLabel.textContent = e != null && !isNaN(e) && !isNaN(s) && e > s ? `${fmt(e - s)} を保存` : "";
    }
    el.querySelectorAll(".ytt-time").forEach((i) => i.addEventListener("input", updateLen));

    // 区間指定は使うときだけ開く。閉じると動画全体の保存に戻る
    function setRange(open) {
      range.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector("span").textContent = open ? "区間指定をやめる" : "区間を指定";
      toggle.querySelector("svg").outerHTML = open ? ICON.close : ICON.scissors;
      el.querySelectorAll(".ytt-save span").forEach((s) => {
        s.textContent = (s.parentNode.dataset.kind === "clip" ? "動画" : "音声") + (open ? "の区間を保存" : "を保存");
      });
      if (open) {
        const v = video();
        if (v && !input("start").value) input("start").value = fmt(v.currentTime);
        input("end").focus();
      } else {
        input("start").value = input("end").value = "";
      }
      updateLen();
    }
    el._setRange = setRange;
    toggle.addEventListener("click", () => setRange(range.hidden));

    el.querySelectorAll(".ytt-now").forEach((b) =>
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        const v = video();
        if (v) input(b.dataset.k).value = fmt(v.currentTime);
        updateLen();
      }));

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
        const useRange = !range.hidden;
        const start = useRange ? parse(input("start").value) : null;
        const end = useRange ? parse(input("end").value) : null;
        if (!url) return;
        if (Number.isNaN(start) || Number.isNaN(end)) {
          showError(jobs, "時間は 1:23 や 1:02:03 の形式で入力してください");
          return;
        }
        try {
          const job = await api("/api/download", "POST", {
            url, kind: b.dataset.kind, start, end,
            quality: el.querySelector(".ytt-quality").value,
            audio_format: el.querySelector(".ytt-afmt").value,
          });
          watchJob(job.id, jobs);
        } catch (err) {
          showError(jobs, err.message);
        }
      }));

    return el;
  }

  function showError(box, msg) {
    const row = document.createElement("div");
    row.className = "ytt-job error";
    row.textContent = "⚠ " + msg;
    box.prepend(row);
    setTimeout(() => row.remove(), 8000);
  }

  const watching = new Set();
  let polling = false;

  async function watchJob(id, box) {
    watching.add(id);
    if (polling) return;
    polling = true;
    const label = { queued: "待機中", downloading: "ダウンロード中", processing: "変換中" };
    while (watching.size) {
      let list;
      try { list = await api("/api/jobs"); } catch (err) { showError(box, err.message); watching.clear(); break; }
      for (const j of list.filter((x) => watching.has(x.id))) {
        let row = box.querySelector(`[data-job="${j.id}"]`);
        if (!row) {
          row = document.createElement("div");
          row.className = "ytt-job";
          row.dataset.job = j.id;
          row.innerHTML = `<span class="ytt-job-icon">${j.kind === "clip" ? ICON.film : ICON.music}</span>
            <div class="ytt-job-main"><div class="ytt-job-name"></div><div class="ytt-job-bar"><i></i></div></div>
            <span class="ytt-job-state"></span>`;
          box.prepend(row);
        }
        const name = j.status === "done" ? (j.file?.split("/").pop() || j.title) : (j.title || "取得中…");
        row.querySelector(".ytt-job-name").textContent = name;
        row.querySelector(".ytt-job-bar i").style.width = `${Math.round(j.progress || 0)}%`;
        const state = row.querySelector(".ytt-job-state");
        if (j.status === "done") {
          watching.delete(j.id);
          row.classList.add("done");
          state.textContent = "";
          const reveal = document.createElement("button");
          reveal.className = "ytt-ghost";
          reveal.innerHTML = `${ICON.folder}<span>Finderで表示</span>`;
          reveal.onclick = () => api(`/api/jobs/${j.id}/reveal`, "POST").catch((e) => showError(box, e.message));
          state.appendChild(reveal);
          setTimeout(() => row.remove(), 60_000); // 完了した行はしばらく表示しておく
        } else if (j.status === "error") {
          watching.delete(j.id);
          row.classList.add("error");
          row.querySelector(".ytt-job-name").textContent = "⚠ 失敗: " + j.error;
          state.textContent = "";
        } else {
          state.textContent = `${label[j.status] || j.status}${j.progress != null ? ` ${Math.round(j.progress)}%` : ""}`;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
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
    // 別の動画に移ったら区間指定を閉じる
    document.getElementById(PANEL_ID)?._setRange?.(false);
    setTimeout(mount, 300);
  });
  new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
  mount();
})();
