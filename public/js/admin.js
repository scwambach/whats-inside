const app = document.getElementById("app");

// Bins arrive in list order; each has a permanent `id` and a saved, editable `number`.
let bins = [];
const selected = new Set(); // bin ids
let filter = "";
// Reorder state: the last move (for undo), whether a save is in flight,
// and the timer that hides the "Order saved" bar.
let lastMove = null;
let savingOrder = false;
let statusTimer;

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
  const path = location.hash.replace(/^#/, "");
  const binMatch = path.match(/^\/bin\/([a-z0-9]+)$/);

  if (path === "/new") return showEditor(null);
  if (binMatch) {
    const bin = bins.find((b) => b.id === binMatch[1]);
    if (bin) return showEditor(bin);
    toast("That bin doesn't exist");
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
  lastMove = null;
  clearTimeout(statusTimer);
  document.title = "Admin · What's Inside";
  app.innerHTML = `
    <div class="toolbar">
      <a class="btn primary" href="#/new">+ New bin</a>
      <input type="search" id="filter" placeholder="Filter bins" value="${esc(filter)}" aria-label="Filter bins">
    </div>
    <div class="select-bar">
      <span>
        <label class="small"><input type="checkbox" id="select-all"> Select all</label>
        <span class="muted small" id="drag-hint">· Drag ⠿ to reorder</span>
      </span>
      <span>
        <button class="btn" id="print-selected"></button>
        <button class="btn link" id="logout">Log out</button>
      </span>
    </div>
    <div class="reorder-status hidden" id="reorder-status" role="status"></div>
    <ul class="bin-list" id="list"></ul>`;

  app.querySelector("#filter").addEventListener("input", (e) => {
    filter = e.target.value;
    renderList();
  });
  app.querySelector("#select-all").addEventListener("change", (e) => {
    for (const bin of visibleBins()) e.target.checked ? selected.add(bin.id) : selected.delete(bin.id);
    renderList();
  });
  app.querySelector("#print-selected").addEventListener("click", () => {
    const ids = bins.filter((b) => selected.has(b.id)).map((b) => b.id);
    window.open(`/print?bins=${ids.join(",")}`, "_blank");
  });
  app.querySelector("#logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    showLogin();
  });
  app.querySelector("#list").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
    updateSelection();
  });
  app.querySelector("#reorder-status").addEventListener("click", (e) => {
    if (e.target.closest("#undo-move")) undoMove();
  });
  enableDrag(app.querySelector("#list"));
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
  const listEl = app.querySelector("#list");
  // Dragging is only offered on the full list, where position maps cleanly to number.
  const filtering = Boolean(filter.trim());
  listEl.classList.toggle("filtering", filtering);
  listEl.classList.toggle("saving", savingOrder);
  app.querySelector("#drag-hint").classList.toggle("hidden", filtering || bins.length < 2);
  const visible = visibleBins();
  if (!bins.length) {
    listEl.innerHTML = `<li><span style="padding:16px" class="muted">No bins yet. Click “New bin” to add one.</span></li>`;
  } else if (!visible.length) {
    listEl.innerHTML = `<li><span style="padding:16px" class="muted">No bins match “${esc(filter)}”.</span></li>`;
  } else {
    listEl.innerHTML = visible.map((bin) => `
      <li>
        <label class="check"><input type="checkbox" value="${bin.id}" ${selected.has(bin.id) ? "checked" : ""} aria-label="Select bin ${bin.number}"></label>
        <a href="#/bin/${bin.id}">
          <span class="bin-head"><span class="bin-num">${bin.number}</span> <strong>${esc(bin.name || `Bin ${bin.number}`)}</strong></span>
          <span class="sub">${[bin.location, itemCount(bin)].filter(Boolean).map(esc).join(" · ")}</span>
        </a>
        <button type="button" class="handle" title="Drag to reorder" aria-label="Move bin ${bin.number}. Use arrow keys to move it up or down.">⠿</button>
      </li>`).join("");
  }
  updateSelection();
}

function updateSelection() {
  const visible = visibleBins();
  const button = app.querySelector("#print-selected");
  button.textContent = `Print labels (${selected.size})`;
  button.disabled = selected.size === 0;
  app.querySelector("#select-all").checked = visible.length > 0 && visible.every((b) => selected.has(b.id));
}

// ---- Drag to reorder ----

function enableDrag(listEl) {
  listEl.addEventListener("keydown", (e) => {
    const handle = e.target.closest(".handle");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(e.key) || filter.trim() || savingOrder) return;
    e.preventDefault();
    const from = [...listEl.children].indexOf(handle.closest("li"));
    const to = from + (e.key === "ArrowUp" ? -1 : 1);
    if (to >= 0 && to < bins.length) moveBin(from, to, { refocus: true });
  });

  // Stop the drag from selecting text along the way.
  listEl.addEventListener("mousedown", (e) => {
    if (e.target.closest(".handle")) e.preventDefault();
  });

  listEl.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".handle");
    if (!handle || filter.trim() || savingOrder || e.button !== 0 || bins.length < 2) return;
    e.preventDefault();

    const row = handle.closest("li");
    const rows = [...listEl.children];
    const from = rows.indexOf(row);
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    const pitch = tops[1] - tops[0]; // row height plus gap
    const startY = e.clientY + scrollY;
    let pointerY = e.clientY;
    let to = from;
    let frame;

    row.classList.add("dragging");
    document.body.classList.add("is-dragging");
    handle.setPointerCapture(e.pointerId);

    const update = () => {
      // Scroll the page when dragging near the top or bottom edge.
      if (pointerY < 80) scrollBy(0, -10);
      else if (pointerY > innerHeight - 80) scrollBy(0, 10);

      const dy = pointerY + scrollY - startY;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / pitch)));
      row.style.transform = `translateY(${dy}px)`;
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = from < to && i > from && i <= to ? -pitch : from > to && i >= to && i < from ? pitch : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : "";
      });
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);

    const onMove = (ev) => (pointerY = ev.clientY);
    const onEnd = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      document.body.classList.remove("is-dragging");
      row.classList.remove("dragging");
      rows.forEach((r) => (r.style.transform = ""));
      getSelection()?.removeAllRanges();
      if (to !== from) moveBin(from, to);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });
}

// Moves the bin at list position `from` to `to` and saves right away.
function moveBin(from, to, { refocus = false } = {}) {
  const order = bins.map((b) => b.id);
  order.splice(to, 0, ...order.splice(from, 1));
  saveOrder(order, { focusIndex: refocus ? to : null });
}

function undoMove() {
  if (lastMove && !savingOrder) saveOrder(lastMove.order, { undo: true });
}

// Saves a new order of bin ids; numbers follow position.
async function saveOrder(order, { focusIndex = null, undo = false } = {}) {
  if (savingOrder) return;
  const previous = { bins, lastMove };
  const byId = new Map(bins.map((b) => [b.id, b]));
  const refocus = () => focusIndex != null && app.querySelectorAll("#list .handle")[focusIndex]?.focus();

  // Show the result immediately; the server confirms it below.
  bins = order.map((id) => byId.get(id));
  lastMove = undo ? null : { order: previous.bins.map((b) => b.id) };
  savingOrder = true;
  renderList();
  refocus();
  showOrderStatus("saving");

  try {
    bins = await api("/api/bins/reorder", { method: "POST", body: { order } });
    showOrderStatus(undo ? "undone" : "saved");
  } catch (err) {
    // Roll back to what the server still has.
    bins = previous.bins;
    lastMove = previous.lastMove;
    showOrderStatus(null);
    handleError(err);
    if (err.status === 409) {
      await loadBins();
      lastMove = null;
    }
  }
  savingOrder = false;
  renderList();
  refocus();
}

// A small bar fixed to the bottom of the screen, so it never shifts the list.
function showOrderStatus(state) {
  const el = app.querySelector("#reorder-status");
  if (!el) return;
  clearTimeout(statusTimer);
  el.classList.toggle("hidden", !state);
  if (!state) return;
  el.innerHTML = state === "saving"
    ? `<span>Saving order…</span>`
    : `<span>${state === "undone" ? "Move undone" : "Order saved"}</span>
       ${lastMove ? `<button type="button" class="btn link" id="undo-move">Undo</button>` : ""}`;
  if (state !== "saving") statusTimer = setTimeout(() => el.classList.add("hidden"), 6000);
}

// ---- Editor ----

function showEditor(bin) {
  const isNew = !bin;
  draft = isNew
    ? { number: bins.reduce((max, b) => Math.max(max, b.number), 0) + 1, name: "", location: "", items: [] }
    : structuredClone(bin);
  document.title = `${isNew ? "New bin" : `Bin ${bin.number}`} · Admin`;

  app.innerHTML = `
    <form class="editor" novalidate>
      <h1><span class="bin-num" id="number-badge">${draft.number}</span> ${isNew ? "New bin" : "Edit bin"}</h1>
      <div class="grid numbered">
        <label class="field">Number <input type="number" name="number" min="1" step="1" inputmode="numeric" value="${esc(draft.number)}"></label>
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
          <a class="btn" href="/bin/${bin.id}" target="_blank">View</a>
          <a class="btn" href="/print?bins=${bin.id}" target="_blank">Print label</a>
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
    } else if (["number", "name", "location"].includes(e.target.name)) {
      draft[e.target.name] = e.target.value;
      if (e.target.name === "number") form.querySelector("#number-badge").textContent = e.target.value || "?";
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
      await api(`/api/bins/${bin.id}`, { method: "DELETE" });
      selected.delete(bin.id);
      await loadBins();
      toast(`Deleted bin ${bin.number}`);
      go("#/");
    } catch (err) {
      handleError(err);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = draft.items.filter((i) => i.name.trim());
    const body = { number: draft.number, name: draft.name, location: draft.location, items };
    const saveButton = form.querySelector("[type=submit]");
    saveButton.disabled = true;
    try {
      let saved;
      if (isNew) {
        saved = await api("/api/bins", { method: "POST", body });
        bins.push(saved);
      } else {
        saved = await api(`/api/bins/${bin.id}`, { method: "PUT", body });
        bins = bins.map((b) => (b.id === saved.id ? saved : b));
      }
      toast(`Saved bin ${saved.number}`);
      go(`#/bin/${saved.id}`);
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
