const app = document.getElementById("app");

let bins = [];
const selected = new Set();
let filter = "";

// Editor state
let draft = null;
let dirty = false;
let currentHash = location.hash;
let ignoreHashChange = false;

init();

async function init() {
  let session;
  try {
    session = await api("/api/session");
  } catch (err) {
    app.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (!session.admin) return showLogin();
  await loadBins();
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });
  route();
}

async function loadBins() {
  bins = await api("/api/bins");
}

function handleError(err) {
  if (err.status === 401) return showLogin();
  toast(err.message);
}

// ---- Routing ----

function onHashChange() {
  if (ignoreHashChange) {
    ignoreHashChange = false;
    return;
  }
  if (dirty && !confirm("You have unsaved changes. Discard them?")) {
    ignoreHashChange = true;
    location.hash = currentHash;
    return;
  }
  route();
}

function route() {
  dirty = false;
  currentHash = location.hash;
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const binMatch = path.match(/^\/bin\/(\d+)$/);

  if (path === "/new") return showEditor(null, params.get("number"));
  if (binMatch) {
    const bin = bins.find((b) => b.number === Number(binMatch[1]));
    if (bin) return showEditor(bin);
    toast(`Bin ${binMatch[1]} doesn't exist`);
  }
  showList();
}

function go(hash) {
  dirty = false;
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---- Login ----

function showLogin() {
  app.innerHTML = `
    <div class="login card">
      <h1>Admin</h1>
      <p class="muted">Enter the password to edit bins.</p>
      <form>
        <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
        <button class="btn primary" type="submit">Log in</button>
        <p class="error small" hidden></p>
      </form>
    </div>`;
  const form = app.querySelector("form");
  const errorEl = form.querySelector(".error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    errorEl.hidden = true;
    try {
      await api("/api/login", { method: "POST", body: { password: form.password.value } });
      init();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      button.disabled = false;
      form.password.select();
    }
  });
}

// ---- Bin list ----

function showList() {
  document.title = "Admin · What's Inside";
  app.innerHTML = `
    <div class="toolbar">
      <a class="btn primary" href="#/new">+ New bin</a>
      <input type="search" id="filter" placeholder="Filter bins" value="${esc(filter)}" aria-label="Filter bins">
    </div>
    <div class="select-bar">
      <label class="small"><input type="checkbox" id="select-all"> Select all</label>
      <span>
        <button class="btn" id="print-selected"></button>
        <button class="btn link" id="logout">Log out</button>
      </span>
    </div>
    <ul class="bin-list" id="list"></ul>`;

  app.querySelector("#filter").addEventListener("input", (e) => {
    filter = e.target.value;
    renderList();
  });
  app.querySelector("#select-all").addEventListener("change", (e) => {
    for (const bin of visibleBins()) e.target.checked ? selected.add(bin.number) : selected.delete(bin.number);
    renderList();
  });
  app.querySelector("#print-selected").addEventListener("click", () => {
    const numbers = [...selected].sort((a, b) => a - b);
    window.open(`/print?bins=${numbers.join(",")}`, "_blank");
  });
  app.querySelector("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    showLogin();
  });
  app.querySelector("#list").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const n = Number(e.target.value);
    e.target.checked ? selected.add(n) : selected.delete(n);
    updateSelection();
  });
  renderList();
}

function visibleBins() {
  const q = filter.trim().toLowerCase();
  if (!q) return bins;
  return bins.filter((bin) =>
    [String(bin.number), bin.name, bin.location, ...bin.items.flatMap((i) => [i.name, i.notes])]
      .some((s) => s && s.toLowerCase().includes(q)));
}

function renderList() {
  const list = app.querySelector("#list");
  const visible = visibleBins();
  if (!bins.length) {
    list.innerHTML = `<li><span style="padding:16px" class="muted">No bins yet. Click “New bin” to add one.</span></li>`;
  } else if (!visible.length) {
    list.innerHTML = `<li><span style="padding:16px" class="muted">No bins match “${esc(filter)}”.</span></li>`;
  } else {
    list.innerHTML = visible.map((bin) => `
      <li>
        <label class="check"><input type="checkbox" value="${bin.number}" ${selected.has(bin.number) ? "checked" : ""} aria-label="Select bin ${bin.number}"></label>
        <a href="#/bin/${bin.number}">
          <span class="bin-head"><span class="bin-num">${bin.number}</span> <strong>${esc(bin.name || `Bin ${bin.number}`)}</strong></span>
          <span class="sub">${[bin.location, itemCount(bin)].filter(Boolean).map(esc).join(" · ")}</span>
        </a>
      </li>`).join("");
  }
  updateSelection();
}

function updateSelection() {
  const visible = visibleBins();
  const button = app.querySelector("#print-selected");
  button.textContent = `Print labels (${selected.size})`;
  button.disabled = selected.size === 0;
  app.querySelector("#select-all").checked = visible.length > 0 && visible.every((b) => selected.has(b.number));
}

// ---- Editor ----

function nextNumber() {
  return bins.reduce((max, b) => Math.max(max, b.number), 0) + 1;
}

function showEditor(bin, suggestedNumber) {
  const isNew = !bin;
  draft = isNew
    ? { number: suggestedNumber || nextNumber(), name: "", location: "", items: [] }
    : structuredClone(bin);
  document.title = `${isNew ? "New bin" : `Bin ${bin.number}`} · Admin`;

  app.innerHTML = `
    <form class="editor" novalidate>
      <h1>${isNew ? "New bin" : `<span class="bin-num">${bin.number}</span> Edit bin`}</h1>
      <div class="grid">
        ${isNew ? `<label class="field wide">Bin number (printed on the label, can't be changed later)
          <input type="number" name="number" min="1" step="1" value="${esc(draft.number)}" required></label>` : ""}
        <label class="field">Name <input type="text" name="name" value="${esc(draft.name)}" placeholder="e.g. Christmas lights"></label>
        <label class="field">Location <input type="text" name="location" value="${esc(draft.location)}" placeholder="e.g. Garage, top shelf"></label>
      </div>

      <h2 style="margin-top:24px">Items <span class="muted" id="item-count"></span></h2>
      <div class="item-rows" id="items"></div>
      <div class="add-item">
        <input type="text" id="new-item" placeholder="Add an item, press Enter" aria-label="New item">
        <button type="button" class="btn" id="add-item">Add</button>
      </div>
      <details>
        <summary>Add several at once</summary>
        <textarea id="bulk" placeholder="One item per line.&#10;Start a line with “3x” to set a quantity, e.g. 3x AA batteries"></textarea>
        <button type="button" class="btn" id="add-bulk" style="margin-top:8px">Add these items</button>
      </details>

      <div class="actions">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn" id="cancel">Cancel</button>
        <span class="spacer"></span>
        ${isNew ? "" : `
          <a class="btn" href="/bin/${bin.number}" target="_blank">View</a>
          <a class="btn" href="/print?bins=${bin.number}" target="_blank">Print label</a>
          <button type="button" class="btn danger" id="delete">Delete</button>`}
      </div>
    </form>`;

  const form = app.querySelector("form");
  const newItem = form.querySelector("#new-item");

  form.addEventListener("input", (e) => {
    dirty = true;
    const row = e.target.closest(".item-row");
    if (row) {
      draft.items[Number(row.dataset.i)][e.target.dataset.field] = e.target.value;
    } else if (["name", "location", "number"].includes(e.target.name)) {
      draft[e.target.name] = e.target.value;
    }
  });

  form.querySelector("#items").addEventListener("click", (e) => {
    const remove = e.target.closest(".remove");
    if (!remove) return;
    draft.items.splice(Number(remove.closest(".item-row").dataset.i), 1);
    dirty = true;
    renderItems();
  });

  const addFromInput = () => {
    const name = newItem.value.trim();
    if (!name) return;
    draft.items.push(parseItem(name));
    newItem.value = "";
    dirty = true;
    renderItems();
    newItem.focus();
  };
  newItem.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  form.querySelector("#add-item").addEventListener("click", addFromInput);

  form.querySelector("#add-bulk").addEventListener("click", () => {
    const bulk = form.querySelector("#bulk");
    const lines = bulk.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    draft.items.push(...lines.map(parseItem));
    bulk.value = "";
    dirty = true;
    renderItems();
    toast(`Added ${lines.length} item${lines.length === 1 ? "" : "s"}`);
  });

  form.querySelector("#cancel").addEventListener("click", () => {
    if (dirty && !confirm("Discard your changes?")) return;
    go("#/");
  });

  form.querySelector("#delete")?.addEventListener("click", async () => {
    if (!confirm(`Delete bin ${bin.number} and its ${itemCount(bin)}? Its printed label will stop working.`)) return;
    try {
      await api(`/api/bins/${bin.number}`, { method: "DELETE" });
      bins = bins.filter((b) => b.number !== bin.number);
      selected.delete(bin.number);
      toast(`Deleted bin ${bin.number}`);
      go("#/");
    } catch (err) {
      handleError(err);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = draft.items.filter((i) => i.name.trim());
    const body = { name: draft.name, location: draft.location, items };
    const saveButton = form.querySelector("[type=submit]");
    saveButton.disabled = true;
    try {
      let saved;
      if (isNew) {
        saved = await api("/api/bins", { method: "POST", body: { ...body, number: draft.number } });
        bins.push(saved);
        bins.sort((a, b) => a.number - b.number);
      } else {
        saved = await api(`/api/bins/${bin.number}`, { method: "PUT", body });
        bins = bins.map((b) => (b.number === saved.number ? saved : b));
      }
      toast(`Saved bin ${saved.number}`);
      go(`#/bin/${saved.number}`);
    } catch (err) {
      saveButton.disabled = false;
      handleError(err);
    }
  });

  renderItems();
  if (isNew) form.querySelector("[name=name]").focus();
}

function renderItems() {
  const container = app.querySelector("#items");
  app.querySelector("#item-count").textContent = draft.items.length ? `(${draft.items.length})` : "";
  container.innerHTML = draft.items.length
    ? draft.items.map((item, i) => `
        <div class="item-row" data-i="${i}">
          <input type="text" data-field="name" value="${esc(item.name)}" placeholder="Item" aria-label="Item name">
          <input type="text" data-field="qty" value="${esc(item.qty)}" placeholder="Qty" aria-label="Quantity">
          <input type="text" class="inotes" data-field="notes" value="${esc(item.notes)}" placeholder="Notes" aria-label="Notes">
          <button type="button" class="btn remove" aria-label="Remove ${esc(item.name)}" title="Remove">×</button>
        </div>`).join("")
    : `<p class="muted small">No items yet.</p>`;
}

// "3x AA batteries" or "3 x AA batteries" -> qty 3
function parseItem(line) {
  const m = line.match(/^(\d+)\s*x\s+(.+)$/i);
  return m ? { name: m[2].trim(), qty: m[1], notes: "" } : { name: line, qty: "", notes: "" };
}
