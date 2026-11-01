// YouTube 左サイドバー（ガイド）に「グループ」セクションを追加し、
// ページを離れずにグループ作成・チャンネルの仕分けができるようにする
(() => {
  const SECTION_ID = "ytt-guide";
  const MENU_ID = "ytt-menu";
  const OPEN_KEY = "ytt-guide-open";
  const COLORS = ["#3ea6ff", "#4caf50", "#ff9800", "#e91e63", "#9c27b0", "#00bcd4", "#ffc107", "#9e9e9e"];

  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>');
  const ICON_RELOAD = svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>');
  const ICON_GEAR = svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');

  function api(path, method = "GET", body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "api", path, method, body }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error("ツールが更新されました。ページを再読み込みしてください"));
        res?.ok ? resolve(res.data) : reject(new Error(res?.error || "不明なエラー"));
      });
    });
  }

  function loadOpen() {
    try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { return new Set(); }
  }
  function setOpen(gid, open) {
    const set = loadOpen();
    open ? set.add(gid) : set.delete(gid);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* 保存できなくても動作に影響なし */ }
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- データ ----------
  let data = null;   // { groups, assignments, channels, auth }
  let error = null;
  let busy = null;   // 処理中メッセージ
  let lastFetch = 0;
  let editing = null; // { kind: "new" } | { kind: "rename", gid }

  async function fetchData(force = false) {
    if (!force && Date.now() - lastFetch < 30_000) return;
    lastFetch = Date.now();
    try {
      const [g, s, auth] = await Promise.all([
        api("/api/groups"), api("/api/subscriptions"), api("/api/auth/status"),
      ]);
      data = { groups: g.groups, assignments: g.assignments, channels: s.channels, auth };
      error = null;
      // ページから読み取る環境では、1日1回自動で登録チャンネルを更新する
      if (!auth.client_secret && s.channels.length && Date.now() / 1000 - s.updated_at > 86400) {
        scrapeSubscriptions()
          .then((channels) => api("/api/subscriptions/import", "POST", { channels }))
          .then(() => fetchData(true))
          .catch(() => { /* 次回また試す */ });
      }
    } catch (e) {
      error = e.message;
    }
    render();
  }

  let saveTimer = null;
  function save() {
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api("/api/groups", "PUT", { groups: data.groups, assignments: data.assignments })
        .catch((e) => { error = "保存できませんでした: " + e.message; render(); });
    }, 200);
  }

  const groupsOf = (chId) => data.assignments[chId] || [];
  function assign(chId, gid, on) {
    const set = new Set(groupsOf(chId));
    on ? set.add(gid) : set.delete(gid);
    if (set.size) data.assignments[chId] = [...set]; else delete data.assignments[chId];
  }
  function createGroup(name) {
    const g = { id: "g" + Date.now().toString(36), name, color: COLORS[data.groups.length % COLORS.length] };
    data.groups.push(g);
    setOpen(g.id, true);
    return g;
  }

  // /@handle や /channel/UC... のリンクから登録チャンネルを特定する
  function channelFromHref(href) {
    if (!data || !href) return null;
    let path;
    try { path = decodeURIComponent(new URL(href, location.origin).pathname); } catch { return null; }
    const m = path.match(/^\/channel\/(UC[\w-]+)/);
    if (m) return data.channels.find((c) => c.id === m[1]) || null;
    const h = path.match(/^\/(@[^/]+)/);
    if (h) return data.channels.find((c) => c.handle === h[1].toLowerCase()) || null;
    return null;
  }

  async function withBusy(msg, fn) {
    busy = msg;
    render();
    try { await fn(); error = null; } catch (e) { error = e.message; }
    busy = null;
    await fetchData(true);
  }
  const login = () => withBusy("ブラウザに開いたGoogleの画面で許可してください…", async () => {
    await api("/api/auth/login", "POST");
    await api("/api/subscriptions/refresh", "POST");
  });
  // API を設定していない環境（他の人に配った版）は YouTube のページから読み取る
  const usesApi = () => data?.auth.client_secret;
  const refreshSubs = () => withBusy("登録チャンネルを読み込み中…", () => (usesApi()
    ? api("/api/subscriptions/refresh", "POST")
    : scrapeSubscriptions().then((channels) => api("/api/subscriptions/import", "POST", { channels }))));

  // ---------- YouTube のページから登録チャンネルを読み取る ----------
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

  const textOf = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";

  function collect(node, channels, tokens) {
    if (Array.isArray(node)) return node.forEach((n) => collect(n, channels, tokens));
    if (!node || typeof node !== "object") return;
    const r = node.channelRenderer;
    if (r?.channelId) {
      const base = r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
      const sub = textOf(r.subscriberCountText);
      const thumbs = r.thumbnail?.thumbnails || [];
      let thumb = thumbs[0]?.url || null;
      if (thumb?.startsWith("//")) thumb = "https:" + thumb;
      channels.set(r.channelId, {
        id: r.channelId,
        title: textOf(r.title),
        thumbnail: thumb,
        handle: base.startsWith("/@") ? decodeURIComponent(base.slice(1)) : sub.startsWith("@") ? sub : null,
      });
    }
    const token = node.continuationCommand?.token;
    if (token) tokens.push(token);
    for (const k in node) if (k !== "channelRenderer") collect(node[k], channels, tokens);
  }

  async function authHeader() {
    const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
    const sid = cookie("SAPISID") || cookie("__Secure-3PAPISID");
    if (!sid) return {};
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${sid} ${location.origin}`));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { Authorization: `SAPISIDHASH ${ts}_${hex}` };
  }

  async function scrapeSubscriptions() {
    const html = await (await fetch("/feed/channels", { credentials: "include" })).text();
    const initial = jsonAfter(html, "ytInitialData");
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    const context = jsonAfter(html, '"INNERTUBE_CONTEXT":');
    const authUser = html.match(/"SESSION_INDEX":"?(\d+)/)?.[1] || "0";
    const channels = new Map();
    let tokens = [];
    collect(initial, channels, tokens);
    // 続き（多数登録している場合）
    for (let page = 0; tokens.length && key && context && page < 50; page++) {
      const res = await fetch(`/youtubei/v1/browse?key=${key}&prettyPrint=false`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Goog-AuthUser": authUser, "X-Origin": location.origin, ...(await authHeader()) },
        body: JSON.stringify({ context, continuation: tokens.shift() }),
      });
      if (!res.ok) break;
      const next = [];
      collect(await res.json(), channels, next);
      tokens = next;
    }
    if (!channels.size) throw new Error("登録チャンネルが見つかりません。YouTubeにログインしてから ↻ を押してください");
    return [...channels.values()];
  }

  // ---------- サイドバー描画 ----------
  function nameInput(initial, onDone) {
    const input = el("input", "ytt-g-input");
    input.value = initial;
    input.placeholder = "グループ名";
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      editing = null;
      const v = input.value.trim();
      ok && v ? onDone(v) : render();
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229) finish(true);
      if (ev.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
    setTimeout(() => { input.focus(); input.select(); });
    return input;
  }

  function render() {
    const section = document.getElementById(SECTION_ID);
    if (!section) return;
    const body = section.querySelector(".ytt-g-body");
    body.innerHTML = "";
    const note = (t) => body.appendChild(el("div", "ytt-g-note", t));
    const action = (label, fn) => {
      const b = el("button", "ytt-g-action", label);
      b.onclick = fn;
      body.appendChild(b);
    };

    if (busy) return note(busy);
    if (error) note("⚠ " + error);
    if (!data) return error ? null : note("読み込み中…");

    if (usesApi() && !data.auth.logged_in) {
      note("YouTubeの登録チャンネルを読み込むためにログインします");
      return action("Googleでログイン", login);
    }
    if (!data.channels.length) {
      note("まず、YouTubeの登録チャンネルを読み込みます");
      return action("登録チャンネルを読み込む", refreshSubs);
    }

    if (editing?.kind === "new") {
      const row = el("div", "ytt-g-item ytt-g-editrow");
      const dot = el("span", "ytt-g-dot");
      dot.style.background = COLORS[data.groups.length % COLORS.length];
      row.append(dot, nameInput("", (name) => { createGroup(name); save(); }));
      body.appendChild(row);
    }

    if (!data.groups.length && editing?.kind !== "new") {
      note("＋ でグループを作り、チャンネルを右クリック（またはここへドラッグ）して追加できます");
      return;
    }

    const chMap = Object.fromEntries(data.channels.map((c) => [c.id, c]));
    const open = loadOpen();

    data.groups.forEach((g) => {
      const channels = Object.keys(data.assignments)
        .filter((ch) => data.assignments[ch].includes(g.id))
        .map((id) => chMap[id]).filter(Boolean)
        .sort((a, b) => a.title.localeCompare(b.title, "ja"));

      const row = el("div", "ytt-g-group" + (open.has(g.id) ? " open" : ""));
      const head = el("div", "ytt-g-item ytt-g-head");
      const dot = el("span", "ytt-g-dot");
      dot.style.background = g.color;
      head.append(el("span", "ytt-g-chev", "›"), dot);

      if (editing?.kind === "rename" && editing.gid === g.id) {
        head.append(nameInput(g.name, (name) => { g.name = name; save(); }));
      } else {
        head.title = `${g.name}（右クリックで編集）`;
        const feed = el("button", "ytt-g-feed", "新着");
        feed.title = "このグループの新着動画を見る";
        feed.onclick = (ev) => {
          ev.stopPropagation();
          chrome.runtime.sendMessage({ type: "openManager", params: `?tab=feed&group=${encodeURIComponent(g.id)}` });
        };
        head.append(el("span", "ytt-g-name", g.name), el("span", "ytt-g-count", String(channels.length)), feed);
        head.onclick = () => { setOpen(g.id, !row.classList.contains("open")); row.classList.toggle("open"); };
        head.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showGroupMenu(ev, g); };
      }

      // ドラッグでチャンネルを追加
      head.ondragover = (ev) => { ev.preventDefault(); head.classList.add("ytt-drop"); };
      head.ondragleave = () => head.classList.remove("ytt-drop");
      head.ondrop = (ev) => {
        ev.preventDefault();
        head.classList.remove("ytt-drop");
        const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
        const ch = channelFromHref(url.split("\n")[0].trim());
        if (!ch) { error = "登録チャンネルとして見つかりませんでした（↻ で一覧を更新できます）"; render(); return; }
        assign(ch.id, g.id, true);
        setOpen(g.id, true);
        error = null;
        save();
      };

      const list = el("div", "ytt-g-list");
      for (const c of channels) {
        const a = el("a", "ytt-g-item ytt-g-ch");
        a.href = `/channel/${c.id}`;
        a.title = c.title;
        const img = el("img", "ytt-g-avatar");
        if (c.thumbnail) img.src = c.thumbnail;
        img.loading = "lazy";
        a.append(img, el("span", "ytt-g-name", c.title));
        list.appendChild(a);
      }
      if (!channels.length) list.appendChild(el("div", "ytt-g-note", "チャンネルを右クリック、またはここへドラッグして追加"));
      row.append(head, list);
      body.appendChild(row);
    });
  }

  function buildSection() {
    const section = el("div");
    section.id = SECTION_ID;
    const title = el("div", "ytt-g-title");
    const iconBtn = (icon, tip, fn) => {
      const b = el("button", "ytt-g-icon");
      b.innerHTML = icon;
      b.title = tip;
      b.onclick = fn;
      return b;
    };
    title.append(
      el("span", null, "📂 グループ"),
      iconBtn(ICON_PLUS, "グループを作成", () => {
        if (!data?.channels.length) return;
        editing = { kind: "new" };
        render();
      }),
      iconBtn(ICON_RELOAD, "登録チャンネルを再読み込み", () => (!usesApi() || data?.auth.logged_in ? refreshSubs() : fetchData(true))),
      iconBtn(ICON_GEAR, "詳細な仕分け画面を開く", () => chrome.runtime.sendMessage({ type: "openManager" })),
    );
    section.append(title, el("div", "ytt-g-body"));
    return section;
  }

  // ---------- 右クリックメニュー ----------
  function closeMenu() { document.getElementById(MENU_ID)?.remove(); }

  function openMenu(ev, build) {
    closeMenu();
    const menu = el("div");
    menu.id = MENU_ID;
    menu.oncontextmenu = (e) => e.preventDefault();
    menu.onmousedown = (e) => e.stopPropagation();
    build(menu);
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + "px";
  }

  const menuItem = (label, fn, cls = "") => {
    const b = el("button", "ytt-m-item " + cls, label);
    b.onclick = fn;
    return b;
  };

  function showChannelMenu(ev, ch) {
    const build = (menu) => {
      menu.innerHTML = "";
      menu.appendChild(el("div", "ytt-m-title", ch.title));
      menu.appendChild(el("div", "ytt-m-sub", "グループに追加"));
      for (const g of data.groups) {
        const on = groupsOf(ch.id).includes(g.id);
        const item = menuItem("", () => { assign(ch.id, g.id, !on); save(); build(menu); });
        const dot = el("span", "ytt-g-dot");
        dot.style.background = g.color;
        item.append(el("span", "ytt-m-check", on ? "✓" : ""), dot, el("span", null, g.name));
        menu.appendChild(item);
      }
      menu.appendChild(el("div", "ytt-m-sep"));
      const add = menuItem("＋ 新しいグループを作って追加…", () => {
        const row = el("div", "ytt-m-editrow");
        row.appendChild(nameInput("", (name) => {
          const g = createGroup(name);
          assign(ch.id, g.id, true);
          save();
          closeMenu();
        }));
        add.replaceWith(row);
      });
      menu.appendChild(add);
    };
    openMenu(ev, build);
  }

  function showGroupMenu(ev, g) {
    openMenu(ev, (menu) => {
      menu.appendChild(el("div", "ytt-m-title", g.name));
      menu.appendChild(menuItem("名前を変更", () => { closeMenu(); editing = { kind: "rename", gid: g.id }; render(); }));
      const colors = el("div", "ytt-m-colors");
      for (const c of COLORS) {
        const sw = el("button", "ytt-m-swatch" + (c === g.color ? " on" : ""));
        sw.style.background = c;
        sw.title = "色を変更";
        sw.onclick = () => { g.color = c; save(); closeMenu(); };
        colors.appendChild(sw);
      }
      menu.appendChild(colors);
      const idx = data.groups.indexOf(g);
      const move = (d) => () => {
        data.groups.splice(idx, 1);
        data.groups.splice(idx + d, 0, g);
        save();
        closeMenu();
      };
      if (idx > 0) menu.appendChild(menuItem("上へ移動", move(-1)));
      if (idx < data.groups.length - 1) menu.appendChild(menuItem("下へ移動", move(1)));
      menu.appendChild(menuItem("新着動画を見る", () => {
        closeMenu();
        chrome.runtime.sendMessage({ type: "openManager", params: `?tab=feed&group=${encodeURIComponent(g.id)}` });
      }));
      menu.appendChild(el("div", "ytt-m-sep"));
      menu.appendChild(menuItem("グループを削除", () => {
        closeMenu();
        if (!confirm(`グループ「${g.name}」を削除しますか？\n（チャンネル登録は解除されません）`)) return;
        data.groups = data.groups.filter((x) => x !== g);
        Object.keys(data.assignments).forEach((ch) => assign(ch, g.id, false));
        save();
      }, "danger"));
    });
  }

  // YouTube 上のチャンネルへのリンク（サイドバー・動画の投稿者など）を右クリック
  document.addEventListener("contextmenu", (ev) => {
    if (ev.shiftKey || !data?.channels.length) return; // Shift+右クリックで通常のメニュー
    const a = ev.target.closest?.("a[href]");
    const ch = a && channelFromHref(a.getAttribute("href"));
    if (!ch) return;
    ev.preventDefault();
    showChannelMenu(ev, ch);
  }, true);

  document.addEventListener("mousedown", closeMenu);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });
  window.addEventListener("blur", closeMenu);
  window.addEventListener("scroll", closeMenu, true);

  // ---------- 設置 ----------
  function mount() {
    const guide = document.querySelector("ytd-guide-renderer #sections");
    if (!guide) return;
    if (guide.querySelector(`#${SECTION_ID}`)) return;
    // 「登録チャンネル」セクションの直前に差し込む（見つからなければ2番目の位置）
    const subsLink = guide.querySelector('a[href="/feed/channels"]');
    const subsSection = subsLink?.closest("ytd-guide-section-renderer")
      || guide.querySelectorAll("ytd-guide-section-renderer")[1];
    guide.insertBefore(buildSection(), subsSection || null);
    render();
    fetchData();
  }

  new MutationObserver(() => {
    if (!document.getElementById(SECTION_ID)) mount();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 詳細画面で変更した内容を、タブに戻ったときに反映
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") fetchData(true);
  });

  mount();
  fetchData();
})();
