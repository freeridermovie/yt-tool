// 登録チャンネルの仕分けページ
const state = {
  channels: [],
  groups: [],
  assignments: {},           // channelId -> [groupId]
  current: "__all__",        // 選択中のグループ (__all__ / __ungrouped__ / groupId)
  tab: "channels",
  selected: new Set(),
  query: "",
};

const $ = (id) => document.getElementById(id);

function notice(html) { $("notice").innerHTML = html ? `<div class="notice">${html}</div>` : ""; }

// ---------- 保存 ----------
let saveTimer = null;
function saveGroups() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api("/api/groups", { method: "PUT", body: { groups: state.groups, assignments: state.assignments } });
    } catch (e) { notice("⚠ 保存に失敗しました: " + escapeHtml(e.message)); }
  }, 300);
}

function groupsOf(chId) { return state.assignments[chId] || []; }

function assign(chId, gid, on) {
  const set = new Set(groupsOf(chId));
  on ? set.add(gid) : set.delete(gid);
  if (set.size) state.assignments[chId] = [...set]; else delete state.assignments[chId];
}

// ---------- 認証 ----------
async function loadAuth() {
  const s = await api("/api/auth/status");
  $("loginBtn").hidden = s.logged_in;
  $("logoutBtn").hidden = !s.logged_in;
  $("refreshBtn").disabled = !s.logged_in;
  $("authStatus").textContent = s.logged_in ? "🟢 YouTubeにログイン済み" : "未ログイン";
  if (!s.client_secret) {
    // API を使わない版: 登録チャンネルは YouTube のページ（サイドバーの ↻）から読み込む
    $("loginBtn").hidden = $("logoutBtn").hidden = $("refreshBtn").hidden = true;
    $("authStatus").textContent = "登録チャンネルは YouTube のサイドバー「📂 グループ」の ↻ で更新できます";
  }
  return s;
}

$("loginBtn").onclick = async () => {
  $("loginBtn").disabled = true;
  notice("ブラウザに開いたGoogleのログイン画面で許可してください…");
  try {
    await api("/api/auth/login", { method: "POST" });
    notice("");
    await loadAuth();
    if (!state.channels.length) await refreshSubs();
  } catch (e) { notice("⚠ " + escapeHtml(e.message)); }
  $("loginBtn").disabled = false;
};

$("logoutBtn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  loadAuth();
};

async function refreshSubs() {
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "取得中…";
  try {
    const data = await api("/api/subscriptions/refresh", { method: "POST" });
    setSubs(data);
  } catch (e) { notice("⚠ " + escapeHtml(e.message)); }
  $("refreshBtn").disabled = false;
  $("refreshBtn").textContent = "🔄 登録チャンネルを取得";
}
$("refreshBtn").onclick = refreshSubs;

function setSubs(data) {
  state.channels = data.channels;
  $("updatedAt").textContent = data.updated_at
    ? `${data.channels.length}チャンネル ・ ${new Date(data.updated_at * 1000).toLocaleString("ja-JP")} 取得`
    : "";
  render();
}

// ---------- サイドバー ----------
function renderGroups() {
  const counts = {};
  let ungrouped = 0;
  for (const c of state.channels) {
    const gs = groupsOf(c.id);
    if (!gs.length) ungrouped++;
    gs.forEach((g) => (counts[g] = (counts[g] || 0) + 1));
  }
  const items = [
    { id: "__all__", name: "すべて", color: "transparent", count: state.channels.length, fixed: true },
    { id: "__ungrouped__", name: "未分類", color: "#888", count: ungrouped, fixed: true },
    ...state.groups.map((g) => ({ ...g, count: counts[g.id] || 0 })),
  ];
  const box = $("groupList");
  box.innerHTML = "";
  items.forEach((g, i) => {
    if (i === 2) box.insertAdjacentHTML("beforeend", '<div class="sep"></div>');
    const el = document.createElement("div");
    el.className = "group-item" + (state.current === g.id ? " active" : "");
    el.innerHTML = `
      <span class="dot" style="background:${g.color}"></span>
      <span class="name">${escapeHtml(g.name)}</span>
      <span class="count">${g.count}</span>
      ${g.fixed ? "" : '<span class="ops"><button data-op="up" title="上へ">↑</button><button data-op="rename" title="名前変更">✎</button><button data-op="delete" title="削除">✕</button></span>'}`;
    el.onclick = (ev) => {
      const op = ev.target.dataset?.op;
      if (op) return groupOp(g.id, op);
      state.current = g.id;
      state.selected.clear();
      render();
    };
    if (!g.fixed) {
      el.ondragover = (ev) => { ev.preventDefault(); el.classList.add("drop"); };
      el.ondragleave = () => el.classList.remove("drop");
      el.ondrop = (ev) => {
        ev.preventDefault();
        el.classList.remove("drop");
        const ids = JSON.parse(ev.dataTransfer.getData("text/plain") || "[]");
        ids.forEach((id) => assign(id, g.id, true));
        saveGroups();
        render();
      };
    }
    box.appendChild(el);
  });

  $("bulkGroup").innerHTML = state.groups
    .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
}

function groupOp(gid, op) {
  const idx = state.groups.findIndex((g) => g.id === gid);
  const g = state.groups[idx];
  if (op === "rename") {
    const name = prompt("グループ名", g.name);
    if (name?.trim()) g.name = name.trim();
  } else if (op === "delete") {
    if (!confirm(`グループ「${g.name}」を削除しますか？（チャンネルの登録は解除されません）`)) return;
    state.groups.splice(idx, 1);
    Object.keys(state.assignments).forEach((ch) => assign(ch, gid, false));
    if (state.current === gid) state.current = "__all__";
  } else if (op === "up" && idx > 0) {
    [state.groups[idx - 1], state.groups[idx]] = [state.groups[idx], state.groups[idx - 1]];
  }
  saveGroups();
  render();
}

$("addGroupForm").onsubmit = (ev) => {
  ev.preventDefault();
  const name = $("newGroupName").value.trim();
  if (!name) return;
  state.groups.push({ id: "g" + Date.now().toString(36), name, color: $("newGroupColor").value });
  $("newGroupName").value = "";
  saveGroups();
  render();
};

// ---------- チャンネル一覧 ----------
function visibleChannels() {
  const q = state.query.toLowerCase();
  return state.channels.filter((c) => {
    const gs = groupsOf(c.id);
    if (state.current === "__ungrouped__" && gs.length) return false;
    if (!state.current.startsWith("__") && !gs.includes(state.current)) return false;
    return !q || c.title.toLowerCase().includes(q);
  });
}

function renderChannels() {
  const grid = $("channelGrid");
  const list = visibleChannels();
  const gmap = Object.fromEntries(state.groups.map((g) => [g.id, g]));
  if (!state.channels.length) {
    grid.innerHTML = '<div class="empty">「Googleでログイン」→「登録チャンネルを取得」で一覧を読み込みます。</div>';
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty">該当するチャンネルはありません。</div>'; return; }

  grid.innerHTML = "";
  for (const c of list) {
    const card = document.createElement("div");
    card.className = "card" + (state.selected.has(c.id) ? " selected" : "");
    card.draggable = true;
    const gs = groupsOf(c.id);
    const addable = state.groups.filter((g) => !gs.includes(g.id));
    card.innerHTML = `
      <input type="checkbox" ${state.selected.has(c.id) ? "checked" : ""}>
      <img class="avatar" src="${escapeHtml(c.thumbnail || "")}" alt="" loading="lazy">
      <div class="body">
        <a class="title" href="https://www.youtube.com/channel/${c.id}" target="_blank">${escapeHtml(c.title)}</a>
        <div class="chips">
          ${gs.map((id) => gmap[id]).filter(Boolean).map((g) =>
            `<button class="chip" data-remove="${g.id}" style="background:${g.color}" title="クリックで外す">${escapeHtml(g.name)}</button>`).join("")}
          ${addable.length ? `<select><option value="">＋ グループ</option>${addable.map((g) =>
            `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>` : ""}
        </div>
      </div>`;
    card.querySelector("input").onchange = (ev) => {
      ev.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id);
      card.classList.toggle("selected", ev.target.checked);
      renderBulk();
    };
    card.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => {
      assign(c.id, b.dataset.remove, false);
      saveGroups();
      render();
    }));
    const sel = card.querySelector("select");
    if (sel) sel.onchange = () => { assign(c.id, sel.value, true); saveGroups(); render(); };
    card.ondragstart = (ev) => {
      const ids = state.selected.has(c.id) ? [...state.selected] : [c.id];
      ev.dataTransfer.setData("text/plain", JSON.stringify(ids));
    };
    grid.appendChild(card);
  }
}

function renderBulk() {
  $("bulk").classList.toggle("show", state.selected.size > 0);
  $("bulkCount").textContent = `${state.selected.size}件を選択中 →`;
  const noGroups = !state.groups.length;
  ["bulkGroup", "bulkAdd", "bulkRemove"].forEach((id) => ($(id).disabled = noGroups));
}

$("search").oninput = (ev) => { state.query = ev.target.value; renderChannels(); };
$("selectAll").onclick = () => { visibleChannels().forEach((c) => state.selected.add(c.id)); render(); };
$("bulkClear").onclick = () => { state.selected.clear(); render(); };
$("bulkAdd").onclick = () => {
  state.selected.forEach((id) => assign(id, $("bulkGroup").value, true));
  state.selected.clear(); saveGroups(); render();
};
$("bulkRemove").onclick = () => {
  state.selected.forEach((id) => assign(id, $("bulkGroup").value, false));
  state.selected.clear(); saveGroups(); render();
};

// ---------- 新着動画 ----------
let feedSeq = 0;
async function renderFeed() {
  const grid = $("feedGrid");
  if (state.current === "__all__") {
    grid.innerHTML = '<div class="empty">左のグループを選ぶと、そのグループのチャンネルの新着動画をまとめて表示します。</div>';
    return;
  }
  const seq = ++feedSeq;
  grid.innerHTML = '<div class="empty">読み込み中…</div>';
  try {
    const videos = await api(`/api/feed?group=${encodeURIComponent(state.current)}&shorts=${$("showShorts").checked}`);
    if (seq !== feedSeq) return;
    if (!videos.length) { grid.innerHTML = '<div class="empty">動画がありません。</div>'; return; }
    grid.innerHTML = videos.map((v) => `
      <a class="video" href="${escapeHtml(v.url)}" target="_blank">
        <img src="${v.thumbnail}" alt="" loading="lazy">
        <div class="vt">${escapeHtml(v.title)}</div>
        <div class="muted">${escapeHtml(v.channel_title)} ・ ${new Date(v.published).toLocaleDateString("ja-JP")}</div>
      </a>`).join("");
  } catch (e) {
    if (seq === feedSeq) grid.innerHTML = `<div class="empty">⚠ ${escapeHtml(e.message)}</div>`;
  }
}
$("showShorts").onchange = renderFeed;
$("reloadFeed").onclick = renderFeed;

document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
  render();
}));

// ---------- 設定 ----------
$("saveOutputDir").onclick = async () => {
  try {
    const s = await api("/api/settings", { method: "PUT", body: { output_dir: $("outputDir").value } });
    $("outputDir").value = s.output_dir;
    notice("保存先を変更しました: " + escapeHtml(s.output_dir));
  } catch (e) { notice("⚠ " + escapeHtml(e.message)); }
};

// ---------- 描画 ----------
function render() {
  renderGroups();
  $("channelsView").hidden = state.tab !== "channels";
  $("feedView").hidden = state.tab !== "feed";
  if (state.tab === "channels") { renderChannels(); renderBulk(); } else renderFeed();
}

(async function init() {
  // サイドバーの「新着」から開かれたときはそのグループの新着を表示
  const params = new URLSearchParams(location.search);
  if (params.get("group")) state.current = params.get("group");
  if (params.get("tab")) {
    state.tab = params.get("tab");
    document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x.dataset.tab === state.tab));
  }
  try {
    const [health, subs, groups] = await Promise.all([
      api("/api/health"), api("/api/subscriptions"), api("/api/groups"),
    ]);
    $("outputDir").value = health.output_dir;
    state.groups = groups.groups;
    state.assignments = groups.assignments;
    setSubs(subs);
    await loadAuth();
  } catch (e) {
    notice("⚠ " + escapeHtml(e.message));
    render();
  }
})();
