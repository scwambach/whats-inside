const root = document.getElementById("bin");
// The QR code links by permanent id; /bin/3 also works and means "whatever bin is #3 now".
const ref = location.pathname.split("/").filter(Boolean)[1] || "";

load();

async function load() {
  if (!/^[a-z0-9]+$/.test(ref)) {
    root.innerHTML = `<h1>Bin not found</h1><p><a href="/">Search all bins</a></p>`;
    return;
  }

  let bin, session;
  try {
    [bin, session] = await Promise.all([
      api(`/api/bins/${ref}`),
      api("/api/session").catch(() => ({ admin: false })),
    ]);
  } catch (err) {
    root.innerHTML = `<h1>Bin</h1><p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (!bin) {
    root.innerHTML = `
      <h1>Bin not found</h1>
      <p class="muted">This bin may have been deleted.</p>
      <p><a class="btn primary" href="/">Search all bins</a></p>`;
    return;
  }

  document.title = `Bin ${bin.number}${bin.name ? ` · ${bin.name}` : ""}`;
  const updated = new Date(bin.updatedAt).toLocaleDateString(undefined, { dateStyle: "medium" });

  root.innerHTML = `
    <div class="bin-head">
      <span class="bin-num lg">${bin.number}</span>
      <h1>${esc(bin.name || `Bin ${bin.number}`)}</h1>
    </div>
    ${bin.location ? `<p class="location">${esc(bin.location)}</p>` : ""}
    ${bin.items.length
      ? `<ul class="items card">${bin.items.map((item) => `
          <li>
            ${esc(item.name)}${item.qty ? `<span class="qty">× ${esc(item.qty)}</span>` : ""}
            ${item.notes ? `<div class="notes">${esc(item.notes)}</div>` : ""}
          </li>`).join("")}</ul>`
      : `<p class="card muted">This bin is empty.</p>`}
    <div class="meta muted small">
      <span>${itemCount(bin)} · updated ${esc(updated)}</span>
      ${session.admin ? `<a class="btn" href="/admin#/bin/${bin.id}">Edit bin</a>` : ""}
    </div>`;
}
