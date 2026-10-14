import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const COOKIE = "wi_session";
const SESSION_SECONDS = 60 * 60 * 24 * 365;
const MAX_ITEMS = 1000;

const ORDER_KEY = "order";

const store = () => getStore({ name: "bins", consistency: "strong" });
const binKey = (id) => `bin/${id}`;

export default async (req) => {
  const { pathname } = new URL(req.url);
  const [resource, id, ...rest] = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  try {
    if (resource === "session" && method === "GET") {
      return json({ admin: isAdmin(req), siteUrl: process.env.URL || null });
    }
    if (resource === "login" && method === "POST") return login(req);
    if (resource === "logout" && method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
    }

    if (resource === "bins" && rest.length === 0) {
      if (!id) {
        if (method === "GET") return json(await listBins());
        if (method === "POST") return requireAdmin(req, () => createBin(req));
      } else if (id === "reorder") {
        if (method === "POST") return requireAdmin(req, () => reorderBins(req));
      } else {
        // A missing bin is null rather than a 404, which Netlify may answer with a static-file fallback.
        if (method === "GET") return json(await findBin(id));
        if (method === "PUT") return requireAdmin(req, () => updateBin(req, id));
        if (method === "DELETE") return requireAdmin(req, () => deleteBin(id));
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong" }, 500);
  }
};

// ---- Bins ----
//
// Each bin is stored under a permanent id ("bin/<id>"), which is what QR codes link to.
// Its number is a saved, editable field, unique across bins. The "order" key lists the
// ids in the order the list is shown, which is independent of the numbers.

async function loadState() {
  const s = store();
  const order = (await s.get(ORDER_KEY, { type: "json" })) ?? (await migrateNumberedBins(s));
  const records = await Promise.all(order.map((id) => s.get(binKey(id), { type: "json" })));
  const bins = records.filter(Boolean);
  // Bins saved while numbers were positions have no number yet: keep the one they showed.
  await Promise.all(bins.map((bin, i) => {
    if (bin.number) return null;
    bin.number = i + 1;
    return s.setJSON(binKey(bin.id), bin);
  }));
  return { order: bins.map((b) => b.id), bins };
}

// Bins created before ids existed were stored under their number ("1", "2", …).
async function migrateNumberedBins(s) {
  const { blobs } = await s.list();
  const keys = blobs.map((b) => b.key).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
  const order = [];
  for (const key of keys) {
    const old = await s.get(key, { type: "json" });
    if (!old) continue;
    const bin = { ...old, number: Number(key) };
    // Derived from the old data, so two requests migrating at once produce the same ids.
    bin.id = "m" + createHash("sha256").update(`${key}:${old.createdAt}`).digest("hex").slice(0, 9);
    await s.setJSON(binKey(bin.id), bin);
    order.push(bin.id);
  }
  await s.setJSON(ORDER_KEY, order);
  await Promise.all(keys.map((k) => s.delete(k)));
  return order;
}

function newId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    const id = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
    if (/[a-z]/.test(id)) return id; // never all digits, so it can't be mistaken for a number
  }
}

const listBins = async () => (await loadState()).bins;

// Looks a bin up by id, or by number (for links like /bin/3).
async function findBin(ref) {
  const { bins } = await loadState();
  if (/^\d+$/.test(ref)) return bins.find((b) => b.number === Number(ref)) ?? null;
  return bins.find((b) => b.id === ref) ?? null;
}

async function createBin(req) {
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  // New bins go at the end of the list, numbered one past the highest unless a number is given.
  const { order, bins } = await loadState();
  let number = bins.reduce((max, b) => Math.max(max, b.number), 0) + 1;
  if (body.number != null && body.number !== "") {
    number = parseNumber(body.number);
    if (!number) return json({ error: "Bin number must be a positive whole number" }, 400);
  }
  const taken = numberTaken(bins, number);
  if (taken) return taken;
  const now = new Date().toISOString();
  const bin = { id: newId(), number, ...cleanBin(body), createdAt: now, updatedAt: now };
  const s = store();
  await s.setJSON(binKey(bin.id), bin);
  await s.setJSON(ORDER_KEY, [...order, bin.id]);
  return json(bin, 201);
}

async function updateBin(req, id) {
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const bins = await listBins();
  const existing = bins.find((b) => b.id === id);
  if (!existing) return json({ error: "That bin doesn't exist" }, 404);

  let number = existing.number;
  if (body.number != null && body.number !== "") {
    number = parseNumber(body.number);
    if (!number) return json({ error: "Bin number must be a positive whole number" }, 400);
  }
  const taken = numberTaken(bins.filter((b) => b.id !== id), number);
  if (taken) return taken;
  // Only fields present in the request change, so a partial update can't wipe the rest.
  const fields = Object.fromEntries(Object.entries(cleanBin(body)).filter(([key]) => key in body));
  const bin = { ...existing, ...fields, number, updatedAt: new Date().toISOString() };
  await store().setJSON(binKey(id), bin);
  return json(bin);
}

async function reorderBins(req) {
  const body = await readBody(req);
  const next = Array.isArray(body?.order) ? body.order.map(String) : [];
  const { order } = await loadState();
  const valid = next.length === order.length && new Set(next).size === next.length && next.every((id) => order.includes(id));
  if (!valid) return json({ error: "Bins changed since this page loaded. Reload and try again." }, 409);

  await store().setJSON(ORDER_KEY, next);
  return json(await listBins());
}

async function deleteBin(id) {
  const { order } = await loadState();
  const s = store();
  await s.setJSON(ORDER_KEY, order.filter((x) => x !== id));
  await s.delete(binKey(id));
  return json({ ok: true });
}

function cleanBin(body) {
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({ name: text(i?.name, 200), qty: text(i?.qty, 30), notes: text(i?.notes, 1000) }))
    .filter((i) => i.name)
    .slice(0, MAX_ITEMS);
  return { name: text(body.name, 120), location: text(body.location, 120), items };
}

function numberTaken(bins, number) {
  const other = bins.find((b) => b.number === number);
  if (!other) return null;
  return json({ error: `Bin ${number} already exists${other.name ? ` (${other.name})` : ""}` }, 409);
}

function parseNumber(value) {
  const s = String(value).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

// ---- Auth ----

async function login(req) {
  if (!process.env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD isn't set in the Netlify environment variables" }, 500);
  }
  const body = await readBody(req);
  if (!body || !safeEqual(String(body.password ?? ""), process.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500));
    return json({ error: "Wrong password" }, 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return json({ ok: true }, 200, { "set-cookie": cookie(`${exp}.${sign(exp)}`, SESSION_SECONDS) });
}

function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp));
}

function requireAdmin(req, handler) {
  return isAdmin(req) ? handler() : json({ error: "Please log in" }, 401);
}

// Signing with the password means changing it logs out every device.
function sign(value) {
  return createHmac("sha256", `whats-inside:${process.env.ADMIN_PASSWORD}`).update(String(value)).digest("base64url");
}

function safeEqual(a, b) {
  const hash = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ---- Helpers ----

async function readBody(req) {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
