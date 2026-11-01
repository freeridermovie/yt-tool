document.getElementById("open").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") }));

async function refresh() {
  const server = document.getElementById("server");
  const box = document.getElementById("jobs");
  try {
    const h = await api("/api/health");
    server.textContent = `🟢 サーバー接続中 ・ 保存先: ${h.output_dir}`;
    const jobs = await api("/api/jobs");
    box.innerHTML = jobs.length ? "" : '<div class="muted">まだ保存履歴はありません。動画ページの下に出るパネルから保存できます。</div>';
    for (const j of jobs) {
      const div = document.createElement("div");
      div.className = "job";
      const range = j.start != null || j.end != null ? ` ${fmtSec(j.start || 0)}–${j.end != null ? fmtSec(j.end) : "最後"}` : "";
      const pct = ["downloading", "processing"].includes(j.status) && j.progress != null ? ` ${Math.round(j.progress)}%` : "";
      div.innerHTML = `
        <div class="t">${j.kind === "clip" ? "🎬" : "🎵"} ${escapeHtml(j.title || j.url)}</div>
        <div class="m"><span>${STATUS_LABEL[j.status] || j.status}${pct}${escapeHtml(range)}</span></div>`;
      if (j.status === "done") {
        const b = document.createElement("button");
        b.className = "btn small";
        b.textContent = "Finderで表示";
        b.onclick = () => api(`/api/jobs/${j.id}/reveal`, { method: "POST" }).catch((e) => alert(e.message));
        div.querySelector(".m").appendChild(b);
      } else if (j.status === "error") {
        div.title = j.error;
      }
      box.appendChild(div);
    }
  } catch (e) {
    server.textContent = "🔴 " + e.message;
    box.innerHTML = "";
  }
}

refresh();
setInterval(refresh, 1500);
