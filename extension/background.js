// コンテンツスクリプト (youtube.com) からのAPI呼び出しを中継する
const API_BASE = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "api") {
    fetch(API_BASE + msg.path, {
      method: msg.method || "GET",
      headers: msg.body ? { "Content-Type": "application/json" } : {},
      body: msg.body ? JSON.stringify(msg.body) : undefined,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        sendResponse(res.ok ? { ok: true, data } : { ok: false, error: data.detail || `HTTP ${res.status}` });
      })
      .catch(() => sendResponse({ ok: false, error: "ローカルサーバーに接続できません（YouTube Tool を起動してください）" }));
    return true;
  }
  if (msg.type === "openManager") {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") + (msg.params || "") });
  }
});

// 自動アップデート: サーバーが新しい版に入れ替えた拡張機能のファイルを読み込み直す
async function checkUpdate() {
  try {
    const h = await (await fetch(API_BASE + "/api/health")).json();
    if (h.auto_update && h.extension_version && h.extension_version !== chrome.runtime.getManifest().version) {
      chrome.runtime.reload();
    }
  } catch { /* サーバー停止中は何もしない */ }
}
chrome.alarms.create("update", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "update") checkUpdate(); });
chrome.runtime.onStartup.addListener(checkUpdate);
checkUpdate();
