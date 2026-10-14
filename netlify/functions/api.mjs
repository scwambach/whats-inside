import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const COOKIE = "wi_session";
const SESSION_SECONDS = 60 * 60 * 24 * 365;
const MAX_ITEMS = 1000;

const store = () => getStore({ name: "bins", consistency: "strong" });

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
      } else {
        const number = parseNumber(id);
        if (!number) return json({ error: "Invalid bin number" }, 400);
        // A missing bin is null rather than a 404, which Netlify may answer with a static-file fallback.
        if (method === "GET") return json((await store().get(String(number), { type: "json" })) ?? null);
        if (method === "PUT") return requireAdmin(req, () => updateBin(req, number));
        if (method === "DELETE") return requireAdmin(req, () => deleteBin(number));
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong" }, 500);
  }
};

// ---- Bins ----

async function listBins() {
  const s = store();
  const { blobs } = await s.list();
  const bins = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return bins.filter(Boolean).sort((a, b) => a.number - b.number);
}

async function createBin(req) {
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const all = await listBins();
  let number;
  if (body.number != null && body.number !== "") {
    number = parseNumber(String(body.number));
    if (!number) return json({ error: "Bin number must be a positive whole number" }, 400);
    if (all.some((b) => b.number === number)) {
      return json({ error: `Bin ${number} already exists` }, 409);
    }
  } else {
    number = all.reduce((max, b) => Math.max(max, b.number), 0) + 1;
  }

  const now = new Date().toISOString();
  const bin = { number, ...cleanBin(body), createdAt: now, updatedAt: now };
  await store().setJSON(String(number), bin);
  return json(bin, 201);
}

async function updateBin(req, number) {
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const existing = await store().get(String(number), { type: "json" });
  if (!existing) return json({ error: `Bin ${number} doesn't exist` }, 404);

  const bin = { ...existing, ...cleanBin(body), number, updatedAt: new Date().toISOString() };
  await store().setJSON(String(number), bin);
  return json(bin);
}

async function deleteBin(number) {
  await store().delete(String(number));
  return json({ ok: true });
}

function cleanBin(body) {
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((i) => ({ name: text(i?.name, 200), qty: text(i?.qty, 30), notes: text(i?.notes, 1000) }))
    .filter((i) => i.name)
    .slice(0, MAX_ITEMS);
  return { name: text(body.name, 120), location: text(body.location, 120), items };
}

function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

function parseNumber(value) {
  if (!/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
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
