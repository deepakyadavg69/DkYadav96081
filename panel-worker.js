/**
 * panel-worker.js — 🎛️ Guardian Panel ka PUL (Cloudflare Worker, ₹0)
 *
 * Kaam: aapke phone (app) aur panel ke beech sirf **commands aur halat** ka aana-jaana.
 * Koi teesri site nahi · koi bharosa-wala data store nahi · sab kuchh aapke apne account me.
 *
 * 🔐 Suraksha:
 *   · App ka **pairing key** pehli baar judne par us device se bandh ho jaata hai (bind)
 *   · Panel ko app hi bulata hai — **ticket** 30 minute ka, ek hi device ka
 *   · Ticket ke bina panel halat nahi padh sakta, command nahi bhej sakta
 *   · Purane data apne aap mit jaate hain (TTL)
 *
 * ⚙️ Setup (ek baar):
 *   1. KV namespace banayein: naam `guard-panel`  → binding ka naam `PANEL`
 *   2. (Chahein to) Variable: `PAGE = https://deepakyadavg69.github.io/DkYadav96081/panel.html`
 *   3. Deploy → jo URL mile wahi bot me:  /panel url https://xxxx.workers.dev
 */

const TICKET_TTL = 1800;      // 30 minute
const KEEP = 40;              // kitni khabrein yaad rahen
const QMAX = 10;              // ek baar me kitni command

/**
 * 🗂️ Data rakhne ki jagah:
 *   · KV binding (PANEL) laga ho → wahin (100% pakka, sab jagah ek jaisa)
 *   · na laga ho → Cloudflare ke apne andar wala cache (best-effort, koi setup nahi)
 * Isliye **bina KV bhi worker chal jata hai** — sirf code paste karo, Deploy, bas.
 */
function storeOf(env) {
  if (env.PANEL && typeof env.PANEL.get === "function") return env.PANEL;
  const C = (typeof caches !== "undefined" && caches.default) ? caches.default : null;
  if (!C) return { async get() { return null; }, async put() {} };
  const u = (k) => "https://guard-panel.local/k/" + encodeURIComponent(k);
  return {
    async get(k) { try { const r = await C.match(u(k)); return r ? await r.text() : null; } catch (_) { return null; } },
    async put(k, v, opt) {
      const ttl = (opt && opt.expirationTtl) || 3600;
      try { await C.put(new Request(u(k)), new Response(String(v), { headers: { "Cache-Control": "max-age=" + ttl } })); } catch (_) {}
    },
  };
}

export default {
  async fetch(req, env) {
    env = Object.assign({}, env, { PANEL: storeOf(env) });   // 🗂️ KV ya cache — dono par same kaam
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (p === "/" || p === "/ping") return cors(json({ ok: true, what: "guard-panel", at: Date.now() }));

    try {
      // ---------------- app se: halat + pending command
      if (p === "/state" && req.method === "POST") return cors(json(await onState(env, await req.json())));
      // ---------------- app se: command ka jawab
      if (p === "/result" && req.method === "POST") return cors(json(await onResult(env, await req.json())));
      // ---------------- app se: khabar (jawab / notification)
      if (p === "/event" && req.method === "POST") return cors(json(await onEvent(env, await req.json())));
      // ---------------- app se: panel ke liye niji ticket
      if (p === "/ticket" && req.method === "POST") return cors(json(await onTicket(env, await req.json())));
      // ---------------- panel se: pehli baar khula
      if (p === "/open") return cors(json(await onOpen(env, u)));
      // ---------------- panel se: halat
      if (p === "/s") return cors(json(await onState4Panel(env, u)));
      // ---------------- panel se: command bhejo
      if (p === "/c" && req.method === "POST") return cors(json(await onCmd(env, await req.json())));
      // ---------------- /p/<own> — bot ke Menu button ka paka raasta (khud ticket banata hai)
      if (p.startsWith("/p/")) {
        return cors(await onPerm(env, u, p.slice(3)));
      }
      return cors(json({ ok: false, err: "route nahi mila: " + p }, 404));
    } catch (e) {
      return cors(json({ ok: false, err: String(e && e.message || e) }, 500));
    }
  }
};

// ============================================================ app side

/**
 * 🔐 device id ↔ key ka taala:
 *   id:<id> → key   (ek device par sirf ek hi key chalegi)
 *   d:<key> → id
 * Isse koi anjaan key lekar aapke phone ki halat nahi badal sakta.
 */
async function bindOk(env, key, id) {
  const byKey = await env.PANEL.get("d:" + key);
  const byId = await env.PANEL.get("id:" + id);
  if (byKey && byKey !== id) return false;
  if (byId && byId !== key) return false;
  await env.PANEL.put("d:" + key, id, { expirationTtl: 60 * 60 * 24 * 365 });
  if (!byId) await env.PANEL.put("id:" + id, key, { expirationTtl: 60 * 60 * 24 * 365 });
  return true;
}

async function onState(env, b) {
  const { key, id } = b || {};
  if (!key || !id) return { ok: false, err: "key/id chahiye" };
  if (!(await bindOk(env, key, id))) return { ok: false, err: "ye key is device ki nahi hai" };
  const own = String(b.own || "").slice(0, 40);
  if (own) await ownAdd(env, own, id, b.name || id, b.ver || "");

  const now = Date.now();
  const st = { ...b, at: now };
  delete st.key;                                   // 🔐 key kabhi store nahi
  await env.PANEL.put("st:" + id, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 7 });

  const lastPanel = Number(await env.PANEL.get("lp:" + id) || 0);
  const hot = now - lastPanel < 90_000;            // panel khula hai → app jaldi-jaldi poochhe

  // pending commands utha kar khali kar do
  let cmd = [];
  try {
    const q = JSON.parse(await env.PANEL.get("q:" + id) || "[]");
    if (Array.isArray(q) && q.length) {
      cmd = q.slice(0, QMAX);
      await env.PANEL.put("q:" + id, JSON.stringify(q.slice(cmd.length)), { expirationTtl: 3600 });
    }
  } catch (_) {}

  return { ok: true, hot, cmd };
}

async function onResult(env, b) {
  const { key, id, cid, text, ok } = b || {};
  if (!key || !id || !cid) return { ok: false, err: "adhoora" };
  const bound = await env.PANEL.get("d:" + key);
  if (bound && bound !== id) return { ok: false, err: "key mel nahi khata" };
  if (!bound) return { ok: false, err: "pehle halat bhejo" };
  await env.PANEL.put("r:" + cid, JSON.stringify({ ok: !!ok, text: (text || "").slice(0, 2000), at: Date.now() }), { expirationTtl: 3600 });
  await push(env, "ev:" + id, { kind: "jawab", text: (text || "").slice(0, 400), at: Date.now() });
  return { ok: true };
}

async function onEvent(env, b) {
  const { key, id, text, notif } = b || {};
  if (!key || !id || !text) return { ok: false, err: "adhoora" };
  const bound = await env.PANEL.get("d:" + key);
  if (bound && bound !== id) return { ok: false, err: "key mel nahi khata" };
  if (!bound) return { ok: false, err: "pehle halat bhejo" };
  const box = notif ? "nt:" : "ev:";
  await push(env, box + id, { kind: notif ? "khabar" : "jawab", text: String(text).slice(0, 800), at: Date.now() });
  return { ok: true };
}

async function onTicket(env, b) {
  const { key, id, name, ver } = b || {};
  if (!key || !id) return { ok: false, err: "key/id chahiye" };
  if (!(await bindOk(env, key, id))) return { ok: false, err: "ye key is device ki nahi hai" };

  const own = String(b.own || "").slice(0, 40);
  if (own) await ownAdd(env, own, id, name || id, ver || "");
  const token = rand(24);
  await env.PANEL.put("t:" + token, JSON.stringify({ id, key, own, name: name || id, ver: ver || "", at: Date.now() }),
    { expirationTtl: TICKET_TTL });
  await env.PANEL.put("name:" + id, (name || id) + "|" + (ver || ""), { expirationTtl: 60 * 60 * 24 * 365 });
  return { ok: true, token, exp: Date.now() + TICKET_TTL * 1000 };
}

// ============================================================ panel side

async function onOpen(env, u) {
  const t = u.searchParams.get("t") || "";
  const dev = await ticket(env, t);
  if (!dev) return { ok: false, err: "link purani ho gayi — bot me dobara /panel likhein" };
  await env.PANEL.put("lp:" + dev.id, String(Date.now()), { expirationTtl: 900 });
  const devs = await ownList(env, dev);
  return {
    ok: true, primary: dev.id,
    devs,
    state: await getState(env, dev.id),
    events: await merged(env, devs, "ev:"), notis: await merged(env, devs, "nt:")
  };
}

async function onState4Panel(env, u) {
  const t = u.searchParams.get("t") || "";
  const dev = await ticket(env, t);
  if (!dev) return { ok: false, err: "link purani ho gayi" };
  await env.PANEL.put("lp:" + dev.id, String(Date.now()), { expirationTtl: 900 });
  const cid = u.searchParams.get("cid") || "";
  const devs = await ownList(env, dev);
  const out = {
    ok: true, primary: dev.id, devs,
    state: await getState(env, dev.id),
    events: await merged(env, devs, "ev:"), notis: await merged(env, devs, "nt:")
  };
  if (cid) out.result = JSON.parse(await env.PANEL.get("r:" + cid) || "null");
  return out;
}

async function onCmd(env, b) {
  const { t, text } = b || {};
  if (!t || !text || String(text).trim().length < 2) return { ok: false, err: "adhoori command" };
  const dev = await ticket(env, t);
  if (!dev) return { ok: false, err: "link purani ho gayi — bot me dobara /panel" };
  const txt = String(text).trim().slice(0, 300);
  const cid = rand(10);
  let q = [];
  try { q = JSON.parse(await env.PANEL.get("q:" + dev.id) || "[]"); } catch (_) {}
  if (!Array.isArray(q)) q = [];
  q.push({ cid, text: txt, at: Date.now() });
  await env.PANEL.put("q:" + dev.id, JSON.stringify(q.slice(-QMAX)), { expirationTtl: 3600 });
  await push(env, "ev:" + dev.id, { kind: "bheja", text: txt, at: Date.now() });
  return { ok: true, cid };
}

// ============================================================ chhote helpers

async function ownAdd(env, own, id, name, ver) {
  let a = [];
  try { a = JSON.parse(await env.PANEL.get("own:" + own) || "[]"); } catch (_) {}
  if (!Array.isArray(a)) a = [];
  a = a.filter((x) => x && x.id !== id);
  a.push({ id, name: (name || id).slice(0, 40), ver: ver || "", t: Date.now() });
  await env.PANEL.put("own:" + own, JSON.stringify(a.slice(-6)), { expirationTtl: 60 * 60 * 24 * 30 });
}

async function ownList(env, dev) {
  const out = [];
  let list = [];
  if (dev.own) { try { list = JSON.parse(await env.PANEL.get("own:" + dev.own) || "[]"); } catch (_) {} }
  if (!Array.isArray(list) || !list.length) list = [{ id: dev.id, name: dev.name || dev.id, ver: dev.ver || "" }];
  for (const d of list) {
    const st = await getState(env, d.id);
    out.push({ id: d.id, name: d.name || d.id, ver: (st && st.ver) || d.ver || "", state: st });
  }
  return out;
}

async function merged(env, devs, box) {
  const all = [];
  for (const d of devs) {
    const l = await getList(env, box + d.id);
    for (const it of l) all.push({ ...it, dev: d.name || d.id, did: d.id });
  }
  all.sort((a, b) => (a.at || 0) - (b.at || 0));
  return all.slice(-60);
}

/**
 * 🎛️ Menu button (blue) se aane wala raasta: /p/<own>
 * Isme app ka **owner hash** hai (jo sirf app ke andar banta hai, kahin dikhta nahi).
 * Fresh ticket bana kar panel par bhej deta hai — isliye Menu button hamesha kaam karta hai.
 */
async function onPerm(env, u, own) {
  const page = (env.PAGE || "https://deepakyadavg69.github.io/DkYadav96081/panel.html").trim();
  if (!own || own.length < 12) return Response.redirect(page + "#nokey", 302);
  let list = [];
  try { list = JSON.parse(await env.PANEL.get("own:" + own) || "[]"); } catch (_) {}
  if (!Array.isArray(list) || !list.length) return Response.redirect(page + "#nokey", 302);

  // sabse taaza phone chuno (jiska state sabse naya ho)
  let best = null, bestAt = 0;
  for (const d of list) {
    const st = await getState(env, d.id);
    const at = (st && st.at) || 0;
    if (at >= bestAt) { bestAt = at; best = d; }
  }
  if (!best) return Response.redirect(page + "#nokey", 302);
  if (Date.now() - bestAt > 7 * 24 * 3600 * 1000) return Response.redirect(page + "#nokey", 302);

  const token = rand(24);
  await env.PANEL.put("t:" + token, JSON.stringify({ id: best.id, own, key: "", name: best.name || best.id, ver: best.ver || "", at: Date.now() }),
    { expirationTtl: TICKET_TTL });
  return Response.redirect(page + "#t=" + token + "&w=" + encodeURIComponent(u.origin), 302);
}

async function ticket(env, t) {
  if (!t) return null;
  const raw = await env.PANEL.get("t:" + t);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function getState(env, id) {
  try { return JSON.parse(await env.PANEL.get("st:" + id) || "null"); } catch (_) { return null; }
}

async function getList(env, k) {
  try { const a = JSON.parse(await env.PANEL.get(k) || "[]"); return Array.isArray(a) ? a.slice(-KEEP) : []; }
  catch (_) { return []; }
}

async function push(env, k, item) {
  const a = await getList(env, k);
  a.push(item);
  await env.PANEL.put(k, JSON.stringify(a.slice(-KEEP)), { expirationTtl: 60 * 60 * 24 * 7 });
}

function rand(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, n);
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function cors(r) {
  const h = new Headers(r.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "content-type");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("cache-control", "no-store");
  return new Response(r.body, { status: r.status, headers: h });
}
