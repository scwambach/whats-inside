const sheet = document.getElementById("sheet");
const summary = document.getElementById("summary");
const showNames = document.getElementById("show-names");

showNames.addEventListener("change", () => sheet.classList.toggle("hide-names", !showNames.checked));

load();

async function load() {
  const wanted = (new URLSearchParams(location.search).get("bins") || "")
    .split(",").map(Number).filter((n) => n > 0);

  let bins, session;
  try {
    [bins, session] = await Promise.all([api("/api/bins"), api("/api/session")]);
  } catch (err) {
    summary.textContent = err.message;
    return;
  }

  // Codes always point at the main site URL, even when printing from a preview deploy.
  const base = (session.siteUrl || location.origin).replace(/\/$/, "");
  const list = wanted.length ? bins.filter((b) => wanted.includes(b.number)) : bins;

  if (!list.length) {
    summary.textContent = "No bins to print.";
    return;
  }

  const pages = Math.ceil(list.length / 9);
  summary.textContent = `${list.length} label${list.length === 1 ? "" : "s"} · ${pages} page${pages === 1 ? "" : "s"} · QR codes link to ${base}/bin/…`;
  sheet.innerHTML = list.map((bin) => `
    <div class="label">
      <div class="num">${bin.number}</div>
      <div class="qr">${qrSvg(`${base}/bin/${bin.number}`)}</div>
      <div class="lname">${esc(bin.name)}</div>
    </div>`).join("");
}
