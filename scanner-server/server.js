// Scanner Forex temps réel — serveur relais Twelve Data
// - garde la clé API côté serveur
// - récupère les bougies de chaque paire / unité de temps en respectant le quota
// - (forfait Pro+) reçoit les prix en direct par WebSocket
// - analyse en continu et pousse les opportunités au site via SSE
//
// Node 18+. Dépendance : ws

const http = require("http");
const WebSocket = require("ws");
const { analyzeSymbol, indicators } = require("./analysis");
const auth = require("./auth");

// ================= Configuration (variables d'environnement) =================
const env = process.env;
const API_KEY = env.TWELVEDATA_API_KEY;
const PORT = +env.PORT || 3000;
// Sites autorisés à interroger le serveur (séparés par des virgules)
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGIN || "https://www.zcinvest.co.uk,https://zc-invest.github.io")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const SYMBOLS = (env.SYMBOLS || "EUR/USD,GBP/USD,USD/JPY,XAU/USD").split(",").map((s) => s.trim()).filter(Boolean);
const TF_ORDER = ["1min", "5min", "15min", "30min", "1h", "2h", "4h", "1day"];
const TIMEFRAMES = (env.TIMEFRAMES || "15min,1h,4h").split(",").map((s) => s.trim())
  .filter((t) => TF_ORDER.includes(t)).sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
const USE_WEBSOCKET = env.USE_WEBSOCKET === "true";          // nécessite un forfait avec WebSocket
const CREDITS_PER_MIN = +env.CREDITS_PER_MIN || 8;           // 8 en gratuit
const DAILY_CREDITS = env.DAILY_CREDITS != null ? +env.DAILY_CREDITS : 800; // 0 = illimité
const PRICE_POLL_SECONDS = +env.PRICE_POLL_SECONDS || 0;     // sans WebSocket : 0 = désactivé
const ALERT_MIN_SCORE = +env.ALERT_MIN_SCORE || 60;
const TD_REST = env.TD_REST || "https://api.twelvedata.com";
const TD_WS = env.TD_WS || "wss://ws.twelvedata.com/v1/quotes/price";

if (!API_KEY) { console.error("❌ Variable TWELVEDATA_API_KEY manquante."); process.exit(1); }

const TF_SEC = { "1min": 60, "5min": 300, "15min": 900, "30min": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1day": 86400 };
// Fréquence de rafraîchissement des bougies (minutes), ajustable via REFRESH="15min:10,1h:20"
const REFRESH = { "1min": 1, "5min": 5, "15min": 10, "30min": 15, "1h": 20, "2h": 30, "4h": 60, "1day": 240 };
(env.REFRESH || "").split(",").filter(Boolean).forEach((p) => { const [k, v] = p.split(":"); if (REFRESH[k]) REFRESH[k] = +v; });

// Avec le WebSocket, les bougies se construisent en direct : on rafraîchit l'historique bien moins souvent
if (USE_WEBSOCKET) for (const k in REFRESH) REFRESH[k] = Math.max(REFRESH[k] * 3, 30);

// Ajustement automatique pour tenir dans le quota journalier
function estimateDaily() {
  let n = 0;
  for (const tf of TIMEFRAMES) n += SYMBOLS.length * (1440 / REFRESH[tf]);
  if (!USE_WEBSOCKET && PRICE_POLL_SECONDS) n += SYMBOLS.length * (86400 / PRICE_POLL_SECONDS);
  return Math.round(n);
}
let estimate = estimateDaily();
if (DAILY_CREDITS && estimate > DAILY_CREDITS * 0.9) {
  const f = estimate / (DAILY_CREDITS * 0.9);
  for (const tf of TIMEFRAMES) REFRESH[tf] = Math.ceil(REFRESH[tf] * f);
  console.warn(`⚠️ Quota journalier : rafraîchissements ralentis ×${f.toFixed(1)} pour rester sous ${DAILY_CREDITS} crédits/jour`);
  estimate = estimateDaily();
}
console.log(`📊 ${SYMBOLS.length} paires × ${TIMEFRAMES.join("/")} — ~${estimate} crédits/jour estimés`);
console.log("⏱  Rafraîchissement (min) :", TIMEFRAMES.map((t) => `${t}=${REFRESH[t]}`).join(" "));

// ================= Limiteur de crédits =================
const credits = { window: [], day: new Date().toISOString().slice(0, 10), dayUsed: 0 };
function canSpend(n = 1) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== credits.day) { credits.day = today; credits.dayUsed = 0; }
  credits.window = credits.window.filter((t) => now - t < 61000);
  if (credits.window.length + n > CREDITS_PER_MIN) return false;
  if (DAILY_CREDITS && credits.dayUsed + n > DAILY_CREDITS) return false;
  return true;
}
function spend(n = 1) { for (let i = 0; i < n; i++) credits.window.push(Date.now()); credits.dayUsed += n; }

// ================= Données =================
const store = {};      // store[symbol][tf] = candles[]
const lastPrice = {};  // symbol -> { price, ts }
const pairs = {};      // symbol -> résultat d'analyse
const history = [];    // opportunités détectées (récentes d'abord)
const seen = new Map(); // id -> date de détection
SYMBOLS.forEach((s) => (store[s] = {}));

function parseTime(dt) {
  const iso = dt.length <= 10 ? `${dt}T00:00:00Z` : `${dt.replace(" ", "T")}Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

async function tdGet(path, params) {
  const url = new URL(TD_REST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", API_KEY);
  const r = await fetch(url);
  const j = await r.json();
  if (j.status === "error" || j.code) { const e = new Error(j.message || "Erreur Twelve Data"); e.code = j.code || r.status; throw e; }
  return j;
}

async function fetchCandles(symbol, tf) {
  const j = await tdGet("/time_series", { symbol, interval: tf, outputsize: 300, timezone: "UTC" });
  const c = j.values.map((v) => ({ time: parseTime(v.datetime), open: +v.open, high: +v.high, low: +v.low, close: +v.close })).reverse();
  // conserve une bougie en cours plus récente construite par le flux direct
  const old = store[symbol][tf];
  if (old && old.length && old.at(-1).time > c.at(-1).time) c.push(old.at(-1));
  store[symbol][tf] = c;
  // sans flux direct, le prix courant = clôture de la bougie la plus fine
  if (!USE_WEBSOCKET && (tf === TIMEFRAMES[0] || !lastPrice[symbol])) {
    lastPrice[symbol] = { price: c.at(-1).close, ts: Math.floor(Date.now() / 1000) };
    send("tick", { symbol, price: c.at(-1).close, ts: lastPrice[symbol].ts });
  }
}

async function fetchPrice(symbol) {
  const j = await tdGet("/price", { symbol });
  onTick(symbol, +j.price, Math.floor(Date.now() / 1000));
}

// ================= File de tâches =================
const tasks = []; // { key, run, due }
const queued = new Set();
const nextDue = {};
for (const s of SYMBOLS) for (const tf of TIMEFRAMES) nextDue[`c|${s}|${tf}`] = 0;
if (!USE_WEBSOCKET && PRICE_POLL_SECONDS) for (const s of SYMBOLS) nextDue[`p|${s}`] = 0;

function schedule() {
  const now = Date.now();
  for (const key in nextDue) {
    if (nextDue[key] > now || queued.has(key)) continue;
    queued.add(key);
    tasks.push(key);
  }
}

async function runTask(key) {
  const [type, symbol, tf] = key.split("|");
  try {
    if (type === "c") {
      await fetchCandles(symbol, tf);
      nextDue[key] = Date.now() + REFRESH[tf] * 60000;
      analyze(symbol);
    } else {
      await fetchPrice(symbol);
      nextDue[key] = Date.now() + PRICE_POLL_SECONDS * 1000;
    }
  } catch (e) {
    console.error(`Erreur ${key} : ${e.message}`);
    nextDue[key] = Date.now() + (e.code === 429 ? 60000 : 120000);
  } finally {
    queued.delete(key);
  }
}

setInterval(() => {
  schedule();
  // les tâches les plus en retard passent d'abord
  tasks.sort((a, b) => nextDue[a] - nextDue[b]);
  while (tasks.length && canSpend(1)) { spend(1); runTask(tasks.shift()); }
}, 1000);

// ================= Flux direct (WebSocket, forfait Pro+) =================
let upstream = null, hb = null, delay = 1000;
function connectWS() {
  upstream = new WebSocket(`${TD_WS}?apikey=${encodeURIComponent(API_KEY)}`);
  upstream.on("open", () => {
    console.log("✅ WebSocket Twelve Data connecté");
    delay = 1000;
    upstream.send(JSON.stringify({ action: "subscribe", params: { symbols: SYMBOLS.join(",") } }));
    clearInterval(hb);
    hb = setInterval(() => upstream.readyState === 1 && upstream.send(JSON.stringify({ action: "heartbeat" })), 10000);
  });
  upstream.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.event === "subscribe-status") {
      if (m.fails && m.fails.length) console.error("⚠️ Symboles refusés par le forfait :", JSON.stringify(m.fails));
      if (m.success) console.log("📡 Abonné :", m.success.map((x) => x.symbol).join(", "));
    } else if (m.event === "price" && m.price != null && store[m.symbol]) {
      onTick(m.symbol, +m.price, m.timestamp || Math.floor(Date.now() / 1000));
    }
  });
  upstream.on("close", () => { clearInterval(hb); setTimeout(connectWS, delay); delay = Math.min(delay * 2, 60000); });
  upstream.on("error", (e) => { console.error("WebSocket :", e.message); upstream.close(); });
}

// Met à jour la bougie en cours de chaque unité de temps avec le nouveau prix
const analyzeTimers = {};
function onTick(symbol, price, ts) {
  lastPrice[symbol] = { price, ts };
  for (const tf of TIMEFRAMES) {
    const c = store[symbol][tf];
    if (!c || !c.length) continue;
    const bucket = Math.floor(ts / TF_SEC[tf]) * TF_SEC[tf];
    const last = c.at(-1);
    if (bucket < last.time) continue;
    if (bucket === last.time) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
    else { c.push({ time: bucket, open: price, high: price, low: price, close: price }); if (c.length > 400) c.shift(); }
  }
  send("tick", { symbol, price, ts });
  if (!analyzeTimers[symbol]) analyzeTimers[symbol] = setTimeout(() => { analyzeTimers[symbol] = null; analyze(symbol); }, 3000);
}

// ================= Analyse et alertes =================
function analyze(symbol) {
  const res = analyzeSymbol(symbol, store[symbol], TIMEFRAMES, lastPrice[symbol]?.price);
  pairs[symbol] = res;
  for (const o of res.opportunities) {
    if (seen.has(o.id) || o.score < ALERT_MIN_SCORE) continue;
    seen.set(o.id, Date.now());
    const item = { ...o, detectedAt: Date.now() };
    history.unshift(item);
    if (history.length > 200) history.pop();
    send("opportunity", item);
    console.log(`🎯 ${o.symbol} ${o.tf} ${o.direction} — ${o.setup} (score ${o.score})`);
  }
  send("pair", res);
}

// purge des signaux vus il y a plus de 3 jours
setInterval(() => { const lim = Date.now() - 3 * 86400000; for (const [k, t] of seen) if (t < lim) seen.delete(k); }, 3600000);

// ================= SSE vers le site =================
const clients = new Set();
function send(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function json(res, code, data) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }

function round(v) { return v == null ? null : +v.toPrecision(8); }

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > max) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (ALLOWED_ORIGINS.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const { pathname, searchParams } = new URL(req.url, "http://localhost");

  // ---------- Connexion ----------
  if (pathname === "/login" && req.method === "POST") {
    const ip = clientIp(req);
    if (auth.tooManyAttempts(ip)) return json(res, 429, { error: "Trop de tentatives. Réessaie dans 15 minutes." });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Requête invalide" }); }
    const user = auth.checkCredentials(body.username, body.password);
    if (!user) {
      auth.recordFailure(ip);
      console.warn(`🔒 Échec de connexion (${String(body.username || "").slice(0, 40)}) depuis ${ip}`);
      return json(res, 401, { error: "Identifiant ou mot de passe incorrect" });
    }
    console.log(`🔓 Connexion de ${user}`);
    return json(res, 200, { user, ...auth.issueToken(user) });
  }

  // ---------- Contrôle d'accès ----------
  const PROTECTED = ["/scanner", "/candles", "/stream", "/me"];
  let currentUser = null;
  if (PROTECTED.includes(pathname)) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : searchParams.get("token");
    currentUser = auth.verifyToken(token);
    if (!currentUser) return json(res, 401, { error: "Connexion requise" });
  }

  if (pathname === "/me") return json(res, 200, { user: currentUser });

  if (pathname === "/health") {
    // public : état technique uniquement, aucune donnée de marché
    const loaded = SYMBOLS.reduce((n, s) => n + TIMEFRAMES.filter((tf) => store[s][tf]).length, 0);
    return json(res, 200, {
      ok: true, mode: USE_WEBSOCKET ? "websocket" : "polling",
      websocket: USE_WEBSOCKET ? !!(upstream && upstream.readyState === 1) : null,
      loaded: `${loaded}/${SYMBOLS.length * TIMEFRAMES.length}`,
      credits: { lastMinute: credits.window.length, perMinute: CREDITS_PER_MIN, today: credits.dayUsed, dailyCap: DAILY_CREDITS || null },
    });
  }

  if (pathname === "/scanner") {
    return json(res, 200, {
      config: { symbols: SYMBOLS, timeframes: TIMEFRAMES, mode: USE_WEBSOCKET ? "websocket" : "polling", refresh: REFRESH, alertMinScore: ALERT_MIN_SCORE },
      credits: { today: credits.dayUsed, dailyCap: DAILY_CREDITS || null },
      pairs: SYMBOLS.map((s) => pairs[s]).filter(Boolean),
      history: history.slice(0, 100),
    });
  }

  if (pathname === "/candles") {
    const symbol = searchParams.get("symbol"), tf = searchParams.get("interval");
    const c = store[symbol] && store[symbol][tf];
    if (!c) return json(res, 404, { error: "Données pas encore chargées pour cette paire / unité de temps" });
    const ind = indicators(c);
    const r = (a) => a.map(round);
    return json(res, 200, { symbol, interval: tf, candles: c, e20: r(ind.e20), e50: r(ind.e50), e200: r(ind.e200), rsi: r(ind.rsi) });
  }

  if (pathname === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  res.writeHead(404).end("Not found");
});

server.listen(PORT, () => {
  console.log(`🚀 Scanner sur le port ${PORT} — mode ${USE_WEBSOCKET ? "WebSocket (direct)" : "polling (forfait gratuit)"}`);
  if (USE_WEBSOCKET) connectWS();
});
