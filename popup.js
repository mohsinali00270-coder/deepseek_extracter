const status = document.getElementById("status");
const buttons = ["zipAll", "zipLast", "open", "upload", "book"].map((id) => document.getElementById(id));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeTab();
  return chrome.tabs.sendMessage(tab.id, { type });
}

(async () => {
  const tab = await activeTab();
  if (!tab?.url?.startsWith("https://chat.deepseek.com")) {
    status.textContent = "Open a chat on chat.deepseek.com first.";
    buttons.forEach((b) => (b.disabled = true));
    return;
  }
  try {
    const s = await send("dsx-status");
    status.textContent = `${s.blocks} code block(s) in ${s.responses} response(s) · ${s.named} named file(s)`;
  } catch {
    status.textContent = "Reload the DeepSeek tab once so the extension can attach.";
    buttons.forEach((b) => (b.disabled = true));
  }
})();

document.getElementById("zipAll").onclick = async () => { await send("dsx-zip-all"); window.close(); };
document.getElementById("zipLast").onclick = async () => { await send("dsx-zip-last"); window.close(); };
document.getElementById("open").onclick = async () => { await send("dsx-open"); window.close(); };
document.getElementById("upload").onclick = async () => { await send("dsx-upload"); window.close(); };
document.getElementById("book").onclick = async () => { await send("dsx-book"); window.close(); };
