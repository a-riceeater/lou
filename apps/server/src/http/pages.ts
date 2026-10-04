/** Minimal, styled result page shown in the browser after an OAuth redirect. */
export function resultPage(title: string, message: string, ok: boolean): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--accent:${ok ? "#34c759" : "#ff3b30"}}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--muted:#98989d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"Segoe UI Variable","Segoe UI",system-ui,sans-serif}
.card{background:var(--card);padding:40px 44px;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,.08);max-width:380px;text-align:center}
.dot{width:44px;height:44px;border-radius:50%;background:var(--accent);margin:0 auto 18px;display:grid;place-items:center;color:#fff;font-size:22px}
h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0;color:var(--muted)}
</style></head><body><div class="card"><div class="dot">${ok ? "✓" : "!"}</div><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`;
}
