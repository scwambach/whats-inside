const queryInput = document.getElementById("q");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

let bins = [];
let fuse;

init();

async function init() {
  queryInput.value = new URLSearchParams(location.search).get("q") || "";
  statusEl.textContent = "Loading…";
  try {
    bins = await api("/api/bins");
  } catch (err) {
    statusEl.textContent = err.message;
    return;
  }

  // One record per bin (matches its name/location) and one per item.
  const records = [];
  for (const bin of bins) {
    records.push({ bin, binName: bin.name, location: bin.location });
    for (const item of bin.items) {
      records.push({ bin, item, itemName: item.name, notes: item.notes });
    }
  }
  fuse = new Fuse(records, {
    keys: [
      { name: "itemName", weight: 3 },
      { name: "binName", weight: 2 },
      { name: "notes", weight: 1 },
      { name: "location", weight: 1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    includeMatches: true,
    minMatchCharLength: 2,
  });

  queryInput.addEventListener("input", () => {
    render();
    const url = new URL(location.href);
    queryInput.value.trim() ? url.searchParams.set("q", queryInput.value.trim()) : url.searchParams.delete("q");
    history.replaceState(null, "", url);
  });
  render();
}

function render() {
  const q = queryInput.value.trim();
  if (!q) return renderAll();

  const groups = new Map();
  const group = (bin) => {
    if (!groups.has(bin.number)) groups.set(bin.number, { bin, items: [], binHit: false });
    return groups.get(bin.number);
  };

  // Typing a bin number jumps straight to that bin.
  if (/^\d+$/.test(q)) {
    const bin = bins.find((b) => b.number === Number(q));
    if (bin) group(bin).binHit = true;
  }

  for (const { item: record, matches } of fuse.search(q, { limit: 300 })) {
    const g = group(record.bin);
    if (record.item) g.items.push({ item: record.item, matches });
    else g.binHit = true;
  }

  if (!groups.size) {
    statusEl.textContent = `Nothing matches “${q}”.`;
    resultsEl.innerHTML = "";
    return;
  }

  const itemTotal = [...groups.values()].reduce((n, g) => n + g.items.length, 0);
  const binText = `${groups.size} bin${groups.size === 1 ? "" : "s"}`;
  statusEl.textContent = itemTotal
    ? `${itemTotal} matching item${itemTotal === 1 ? "" : "s"} in ${binText}`
    : `${binText} match${groups.size === 1 ? "es" : ""}`;
  resultsEl.innerHTML = [...groups.values()].map(({ bin, items }) => `
    <a class="card" href="/bin/${bin.number}">
      ${binHead(bin)}
      ${items.length
        ? `<ul class="items">${items.map(({ item, matches }) => itemLi(item, matches)).join("")}</ul>`
        : `<div class="muted small">${itemCount(bin)}</div>`}
    </a>`).join("");
}

function renderAll() {
  if (!bins.length) {
    statusEl.innerHTML = `No bins yet. <a href="/admin">Add your first bin</a>.`;
    resultsEl.innerHTML = "";
    return;
  }
  const total = bins.reduce((n, b) => n + b.items.length, 0);
  statusEl.textContent = `${bins.length} bin${bins.length === 1 ? "" : "s"} · ${total} item${total === 1 ? "" : "s"}`;
  resultsEl.innerHTML = bins.map((bin) => `
    <a class="card" href="/bin/${bin.number}">
      ${binHead(bin)}
      <div class="muted small">${itemCount(bin)}</div>
    </a>`).join("");
}

function binHead(bin) {
  return `<div class="bin-head">
    <span class="bin-num">${bin.number}</span>
    <h2>${esc(bin.name || `Bin ${bin.number}`)}</h2>
    ${bin.location ? `<span class="muted small">${esc(bin.location)}</span>` : ""}
  </div>`;
}

function itemLi(item, matches) {
  return `<li>
    ${highlight(item.name, matches, "itemName")}${item.qty ? `<span class="qty">× ${esc(item.qty)}</span>` : ""}
    ${item.notes ? `<div class="notes">${highlight(item.notes, matches, "notes")}</div>` : ""}
  </li>`;
}

function highlight(text, matches, key) {
  const match = matches?.find((m) => m.key === key);
  if (!match) return esc(text);
  let out = "";
  let last = 0;
  for (const [start, end] of match.indices) {
    if (start < last) continue;
    out += esc(text.slice(last, start)) + `<mark>${esc(text.slice(start, end + 1))}</mark>`;
    last = end + 1;
  }
  return out + esc(text.slice(last));
}
