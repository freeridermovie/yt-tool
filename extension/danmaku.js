// 動画の上にコメントを右から左へ流す（ニコニコ動画風）
// - ライブ配信のアーカイブ: チャットのリプレイを、その時刻に流す
// - 普通の動画: 「1:23 ここ好き」のような時間つきコメントを、その時刻に流す
// プレーヤー右下のボタン（Live Comment / Time Comment）でオン/オフ
(() => {
  const STORE_KEY = "ytt-danmaku";
  const DURATION = 5000;   // 画面を横切る時間 (ms)
  const MAX_ON_SCREEN = 40;

  // オン/オフは字幕ボタンのように、動画・タブを変えても引き継ぐ（拡張機能のストレージに保存）
  let enabled = (() => { try { return localStorage.getItem(STORE_KEY) === "1"; } catch { return false; } })();
  chrome.storage?.local.get(STORE_KEY).then((r) => { if (STORE_KEY in r && r[STORE_KEY] !== enabled) setEnabled(r[STORE_KEY], false); }).catch(() => {});
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === "local" && STORE_KEY in changes && changes[STORE_KEY].newValue !== enabled) setEnabled(changes[STORE_KEY].newValue, false);
  });
  let source = null;       // 今の動画のコメント元
  let lastT = null;        // 前回チェックした再生位置 (秒)
  const lanes = [];        // 段ごとの最後のコメント要素

  const $ = (sel, root = document) => root.querySelector(sel);
  const player = () => $("#movie_player");
  const video = () => $("#movie_player video");
  const videoId = () => (location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null);

  function api(path) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "api", path }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error("ツールが更新されました。ページを再読み込みしてください"));
        res?.ok ? resolve(res.data) : reject(new Error(res?.error || "不明なエラー"));
      });
    });
  }

  // html の marker の直後にある JSON オブジェクトを取り出す
  function jsonAfter(html, marker) {
    let i = html.indexOf(marker);
    if (i < 0) return null;
    i = html.indexOf("{", i + marker.length);
    let depth = 0, inStr = false;
    for (let j = i; j < html.length; j++) {
      const c = html[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return JSON.parse(html.slice(i, j + 1));
    }
    return null;
  }

  // ---------- コメント元: チャットのリプレイ ----------
  // YouTube のチャット欄と同じ仕組み (get_live_chat_replay) で、再生位置の前後のチャットを少しずつ取る
  function chatReplaySource(vid, key, context, firstCont) {
    let items = [];          // { t, runs, paid }
    let from = 0, to = -1;   // 読み込み済みの範囲 (秒)
    let nextCont = null, seekCont = firstCont;
    let loading = false;

    async function request(cont, offsetSec) {
      const res = await fetch(`/youtubei/v1/live_chat/get_live_chat_replay?key=${key}&prettyPrint=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, continuation: cont, currentPlayerState: { playerOffsetMs: String(Math.floor(offsetSec * 1000)) } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lc = (await res.json()).continuationContents?.liveChatContinuation;
      const got = [];
      for (const a of lc?.actions || []) {
        const r = a.replayChatItemAction;
        const t = Number(r?.videoOffsetTimeMsec) / 1000;
        for (const x of r?.actions || []) {
          const item = x.addChatItemAction?.item;
          const m = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer;
          if (m?.message?.runs) got.push({ t, runs: m.message.runs, paid: !!item.liveChatPaidMessageRenderer });
        }
      }
      for (const c of lc?.continuations || []) {
        if (c.liveChatReplayContinuationData) nextCont = c.liveChatReplayContinuationData.continuation;
        if (c.playerSeekContinuationData) seekCont = c.playerSeekContinuationData.continuation;
      }
      if (!lc?.continuations?.some((c) => c.liveChatReplayContinuationData)) nextCont = null;
      return got;
    }

    return {
      label: "Live Comment（チャットのリプレイ）",
      vid,
      // 再生位置 now の少し先まで読み込んでおく
      async ensure(now) {
        if (loading) return;
        const outside = now < from || now > to + 5;
        if (!outside && (now < to - 20 || !nextCont)) return;
        loading = true;
        try {
          if (outside) {
            const got = await request(seekCont, now);
            items = got;
            from = now;
            to = got.length ? got[got.length - 1].t : now;
          } else {
            const got = await request(nextCont, to);
            items = items.filter((x) => x.t >= now - 30).concat(got.filter((x) => x.t > to));
            if (got.length) to = got[got.length - 1].t;
            else to += 30;
          }
        } catch { to = now + 10; } // 失敗したら少し待ってからやり直す
        loading = false;
      },
      between: (a, b) => items.filter((x) => x.t > a && x.t <= b),
    };
  }

  // ---------- コメント元: 時間つきコメント (サーバーが yt-dlp で取得) ----------
  function timedCommentsSource(vid, data) {
    const items = data.comments.map((c) => ({ t: c.t, runs: [{ text: c.text }] }));
    return {
      label: `Time Comment（時間つきコメント ${items.length}件）`,
      vid,
      ensure() {},
      between: (a, b) => items.filter((x) => x.t > a && x.t <= b),
    };
  }

  // 動画の種類（チャットのリプレイがあるか）だけ先に調べる。ボタンの表記に使う
  const kinds = new Map(); // vid -> Promise<{ live, key, context, cont }>
  function detectKind(vid) {
    if (!kinds.has(vid)) {
      kinds.set(vid, fetch(`/watch?v=${vid}`, { credentials: "include" }).then((r) => r.text()).then((html) => {
        const init = jsonAfter(html, "ytInitialData");
        const chat = init?.contents?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
        const cont = chat?.continuations?.[0]?.reloadContinuationData?.continuation;
        const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
        const context = jsonAfter(html, '"INNERTUBE_CONTEXT":');
        return { live: !!(chat?.isReplay && cont && key && context), key, context, cont };
      }).catch(() => ({ live: false })));
    }
    return kinds.get(vid);
  }

  async function loadSource(vid) {
    const k = await detectKind(vid);
    if (k.live) return chatReplaySource(vid, k.key, k.context, k.cont);
    toast("Time Comment: 時間つきコメントを探しています…（10秒ほどかかります）");
    return timedCommentsSource(vid, await api(`/api/comments?v=${vid}`));
  }

  // ---------- 描画 ----------
  function overlay() {
    const p = player();
    if (!p) return null;
    let o = $("#ytt-danmaku", p);
    if (!o) {
      o = document.createElement("div");
      o.id = "ytt-danmaku";
      p.appendChild(o);
    }
    return o;
  }

  function toast(text) {
    const o = overlay();
    if (!o) return;
    let t = $(".ytt-dm-toast", o);
    if (!t) {
      t = document.createElement("div");
      t.className = "ytt-dm-toast";
      o.appendChild(t);
    }
    t.textContent = "💬 " + text;
    t.classList.remove("hide");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add("hide"), 3000);
  }

  function clearComments() {
    overlay()?.querySelectorAll(".ytt-dm").forEach((e) => e.remove());
    lanes.length = 0;
  }

  function emit(item) {
    const o = overlay();
    const v = video();
    if (!o || !v || o.querySelectorAll(".ytt-dm").length >= MAX_ON_SCREEN) return;
    const w = o.clientWidth, h = o.clientHeight;
    const size = Math.max(16, Math.min(40, Math.round(h / 14)));
    const laneCount = Math.max(1, Math.floor((h * 0.85) / (size * 1.25)));

    const el = document.createElement("div");
    el.className = "ytt-dm" + (item.paid ? " paid" : "");
    el.style.fontSize = size + "px";
    for (const r of item.runs) {
      if (r.text) el.append(r.text);
      else if (r.emoji) {
        const url = r.emoji.image?.thumbnails?.[0]?.url;
        if (url) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = r.emoji.shortcuts?.[0] || "";
          el.append(img);
        } else el.append(r.emoji.emojiId || "");
      }
    }
    if (!el.textContent.trim() && !el.querySelector("img")) return;
    o.appendChild(el);

    // 前のコメントの右端が画面に入りきった段を上から探す（無ければ一番空いている段）
    let lane = -1, best = Infinity;
    for (let i = 0; i < laneCount; i++) {
      const prev = lanes[i];
      const right = prev?.isConnected ? prev.getBoundingClientRect().right - o.getBoundingClientRect().left : -Infinity;
      if (right < w - 16) { lane = i; break; }
      if (right < best) { best = right; lane = i; }
    }
    lanes[lane] = el;
    el.style.top = Math.round(h * 0.03 + lane * size * 1.25) + "px";

    const anim = el.animate(
      [{ transform: `translateX(${w}px)` }, { transform: `translateX(${-el.offsetWidth}px)` }],
      { duration: DURATION, easing: "linear" },
    );
    anim.playbackRate = v.playbackRate;
    if (v.paused) anim.pause();
    anim.onfinish = () => el.remove();
  }

  function eachAnim(fn) {
    overlay()?.querySelectorAll(".ytt-dm").forEach((e) => e.getAnimations().forEach(fn));
  }

  // ---------- 再生位置に合わせてコメントを出す ----------
  let loadingVid = null;
  let labelVid = null;
  async function tick() {
    const vid = videoId();
    const v = video();
    const o = overlay();
    if (vid && vid !== labelVid && $("#ytt-dm-btn")) {
      labelVid = vid;
      setLabel("Comment");
      detectKind(vid).then((k) => { if (videoId() === vid) setLabel(k.live ? "Live Comment" : "Time Comment"); });
    }
    if (!enabled || !vid || !v || !o) return;
    o.hidden = !!player()?.classList.contains("ad-showing");
    if (o.hidden) return;

    if (source?.vid !== vid) {
      if (loadingVid === vid) return;
      loadingVid = vid;
      source = null;
      clearComments();
      try {
        const s = await loadSource(vid);
        if (videoId() !== vid) return;
        source = s;
        toast(source.label);
      } catch (e) {
        toast("コメントを読み込めませんでした: " + e.message);
        source = { vid, label: "コメントなし", ensure() {}, between: () => [] }; // 同じ動画では再試行しない
      } finally {
        loadingVid = null;
      }
      lastT = null;
      return;
    }

    const now = v.currentTime;
    source.ensure(now);
    if (lastT == null || now < lastT || now - lastT > 2) { lastT = now; return; } // シーク直後はまとめて流さない
    if (!v.paused) source.between(lastT, now).forEach(emit);
    lastT = now;
  }
  setInterval(tick, 250);

  // 一時停止・倍速に合わせる
  document.addEventListener("pause", (e) => { if (e.target === video()) eachAnim((a) => a.pause()); }, true);
  document.addEventListener("play", (e) => { if (e.target === video()) eachAnim((a) => a.play()); }, true);
  document.addEventListener("ratechange", (e) => {
    if (e.target === video()) eachAnim((a) => { a.playbackRate = e.target.playbackRate; });
  }, true);
  document.addEventListener("seeking", (e) => { if (e.target === video()) clearComments(); }, true);

  // ---------- オン/オフボタン ----------
  function setEnabled(on, persist = true) {
    enabled = on;
    try { localStorage.setItem(STORE_KEY, on ? "1" : "0"); } catch { /* 保存できなくても動作に影響なし */ }
    if (persist) chrome.storage?.local.set({ [STORE_KEY]: on }).catch(() => {});
    const btn = $("#ytt-dm-btn");
    btn?.setAttribute("aria-pressed", String(on));
    if (btn) btn.title = on ? "コメントを流す: オン（クリックでオフ）" : "コメントを流す: オフ（クリックでオン）";
    if (!on) clearComments();
    else if (source?.vid === videoId()) toast(source.label);
    lastT = null;
  }

  function setLabel(text) {
    const icon = $("#ytt-dm-btn .ytt-dm-icon");
    if (icon) icon.textContent = text;
  }

  function mountButton() {
    const controls = $("#movie_player .ytp-right-controls");
    if (!controls || $("#ytt-dm-btn")) return;
    const btn = document.createElement("button");
    btn.id = "ytt-dm-btn";
    btn.className = "ytp-button";
    const icon = document.createElement("span");
    icon.className = "ytt-dm-icon";
    icon.textContent = "Comment";
    btn.appendChild(icon);
    btn.onclick = (e) => { e.stopPropagation(); setEnabled(!enabled); };
    controls.prepend(btn);
    labelVid = null; // 作り直したボタンにも表記を入れ直す
    setEnabled(enabled, false);
  }
  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });
  mountButton();
})();
