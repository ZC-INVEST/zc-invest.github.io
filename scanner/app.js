// Adresse du serveur : définie dans config.js
const API_BASE = (window.SCANNER_API || "").replace(/\/$/, "");

// ---------- Session membre ----------
const SESSION_KEY = "zc_scanner_session";
function getSession() {
  try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY)); return s && s.expiresAt > Date.now() ? s : null; } catch { return null; }
}
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} memSession = s; }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch {} memSession = null; }
let memSession = getSession();

class AuthError extends Error {}
async function api(path) {
  if (!memSession) throw new AuthError();
  const r = await fetch(API_BASE + path, { headers:{ Authorization:"Bearer " + memSession.token } });
  if (r.status === 401) { logout("Ta session a expiré, reconnecte-toi."); throw new AuthError(); }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Erreur serveur");
  return j;
}

const TF_SEC = { "1min":60, "5min":300, "15min":900, "30min":1800, "1h":3600, "2h":7200, "4h":14400, "1day":86400 };
const TF_LABEL = { "1min":"1m", "5min":"5m", "15min":"15m", "30min":"30m", "1h":"1h", "2h":"2h", "4h":"4h", "1day":"1J" };
const S = { config:null, pairs:{}, history:[], selOpp:null, sym:null, tf:null, candles:[], lastPx:{} };
const $ = (id) => document.getElementById(id);

const digits = (sym) => /XAU|XAG/.test(sym) ? 2 : /JPY/.test(sym) ? 3 : 5;
const fmt = (v, sym) => v == null ? "—" : (+v).toFixed(digits(sym));
const trendChip = (t) => t > 0 ? ["up","▲"] : t < 0 ? ["down","▼"] : ["","•"];
const scoreColor = (s) => s >= 75 ? "var(--up)" : s >= 60 ? "var(--acc)" : "var(--mut)";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

// ---------- Opportunités ----------
function allOpps() { return Object.values(S.pairs).flatMap((p) => p.opportunities || []).sort((a, b) => b.score - a.score); }

function renderOpps() {
  const min = +$("fScore").value, dir = $("fDir").value, tf = $("fTf").value;
  const list = allOpps().filter((o) => o.score >= min && (!dir || o.direction === dir) && (!tf || o.tf === tf));
  $("oppBody").innerHTML = list.length ? list.map((o) => `
    <tr data-id="${esc(o.id)}" class="${S.selOpp && S.selOpp.id === o.id ? "sel" : ""}">
      <td><b>${esc(o.symbol)}</b></td><td>${TF_LABEL[o.tf]}</td>
      <td class="${o.direction === "achat" ? "buy" : "sell"}">${o.direction === "achat" ? "▲ Achat" : "▼ Vente"}</td>
      <td>${esc(o.setup)}</td>
      <td><span class="bar"><i style="width:${o.score}%;background:${scoreColor(o.score)}"></i></span>${o.score}</td>
      <td>${fmt(o.entry, o.symbol)}</td><td class="muted">${fmt(o.stop, o.symbol)}</td><td>${fmt(o.tp2, o.symbol)}</td>
      <td class="muted">${o.age === 0 ? "nouveau" : "−" + o.age}</td>
    </tr>`).join("") : `<tr><td colspan="9" class="empty">Aucune opportunité avec ces filtres pour le moment. Le scanner continue de surveiller.</td></tr>`;
}

$("oppBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const o = allOpps().find((x) => x.id === tr.dataset.id); if (!o) return;
  S.selOpp = o; renderOpps(); openChart(o.symbol, o.tf);
});
["fScore", "fDir", "fTf"].forEach((id) => $(id).addEventListener("change", renderOpps));

// ---------- Vue marché ----------
function renderPairs() {
  const tfs = S.config.timeframes;
  $("pairsGrid").innerHTML = S.config.symbols.map((sym) => {
    const p = S.pairs[sym];
    const px = S.lastPx[sym] ?? p?.price;
    const chips = tfs.map((tf) => { const t = p?.trends?.[tf]; const [cls, ar] = trendChip(t?.trend ?? 0);
      return `<span class="chip ${t ? cls : ""}">${TF_LABEL[tf]} ${t ? ar : "…"}</span>`; }).join("");
    const nb = p?.opportunities?.filter((o) => o.score >= (S.config.alertMinScore || 60)).length || 0;
    const r = p?.trends?.[tfs[0]]?.rsi;
    return `<div class="pair" data-sym="${esc(sym)}">
      <div class="sym">${esc(sym)} ${nb ? `<span class="chip" style="background:rgba(212,175,55,.2);color:var(--acc)">${nb} signal${nb > 1 ? "s" : ""}</span>` : ""}</div>
      <div class="px" id="px-${sym.replace("/", "")}">${fmt(px, sym)}</div>
      <div class="muted" style="font-size:12px">RSI ${TF_LABEL[tfs[0]]} : ${r != null ? r.toFixed(0) : "—"}</div>
      <div class="tfs">${chips}</div></div>`;
  }).join("");
}
$("pairsGrid").addEventListener("click", (e) => {
  const d = e.target.closest(".pair"); if (!d) return;
  S.selOpp = null; renderOpps(); openChart(d.dataset.sym, S.tf || S.config.timeframes[0]);
});

// ---------- Graphique ----------
const base = { autoSize:true, layout:{ background:{ color:"#161920" }, textColor:"#c4c8d0" }, grid:{ vertLines:{ color:"#20242d" }, horzLines:{ color:"#20242d" } },
  rightPriceScale:{ borderColor:"#2c313c" }, timeScale:{ timeVisible:true, secondsVisible:false, borderColor:"#2c313c" },
  localization:{ locale:"fr-FR", timeFormatter:(t) => new Date(t * 1000).toLocaleString("fr-FR", { dateStyle:"short", timeStyle:"short" }) } };
const chart = LightweightCharts.createChart($("chart"), base);
const cs = chart.addCandlestickSeries({ upColor:"#22c55e", downColor:"#ef4444", wickUpColor:"#22c55e", wickDownColor:"#ef4444", borderVisible:false });
const l20 = chart.addLineSeries({ color:"#3b82f6", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
const l50 = chart.addLineSeries({ color:"#d4af37", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
const l200 = chart.addLineSeries({ color:"#a1a1aa", lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });
const rsiC = LightweightCharts.createChart($("rsiChart"), { ...base, timeScale:{ visible:false } });
const rs = rsiC.addLineSeries({ color:"#a855f7", lineWidth:1 });
rs.createPriceLine({ price:70, color:"#ef4444", lineStyle:2, axisLabelVisible:false });
rs.createPriceLine({ price:30, color:"#22c55e", lineStyle:2, axisLabelVisible:false });
chart.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rsiC.timeScale().setVisibleLogicalRange(r));
let priceLines = [];

async function openChart(sym, tf) {
  S.sym = sym; S.tf = tf; $("cSym").value = sym; $("cTf").value = tf;
  $("chartTitle").textContent = `${sym} · ${TF_LABEL[tf]}`;
  let j;
  try { j = await api(`/candles?symbol=${encodeURIComponent(sym)}&interval=${tf}`); }
  catch (e) { if (!(e instanceof AuthError)) $("detail").innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
  S.candles = j.candles;
  const line = (arr) => j.candles.map((c, i) => arr[i] == null ? null : { time:c.time, value:arr[i] }).filter(Boolean);
  const prec = { type:"price", precision:digits(sym), minMove:1 / 10 ** digits(sym) };
  cs.applyOptions({ priceFormat:prec }); [l20, l50, l200].forEach((s) => s.applyOptions({ priceFormat:prec }));
  cs.setData(j.candles); l20.setData(line(j.e20)); l50.setData(line(j.e50)); l200.setData(line(j.e200)); rs.setData(line(j.rsi));
  chart.timeScale().fitContent();
  drawOpp();
}

function drawOpp() {
  priceLines.forEach((pl) => cs.removePriceLine(pl)); priceLines = [];
  const o = S.selOpp;
  if (!o || o.symbol !== S.sym || o.tf !== S.tf) {
    $("detail").innerHTML = `<span class="muted">Courbes : EMA 20 (bleu), EMA 50 (or), EMA 200 (gris). Clique sur une opportunité pour afficher ses niveaux.</span>`;
    cs.setMarkers([]); return;
  }
  const add = (price, color, title) => priceLines.push(cs.createPriceLine({ price, color, lineWidth:1, lineStyle:2, title }));
  add(o.entry, "#e6e7ea", "Entrée"); add(o.stop, "#ef4444", "Stop"); add(o.tp1, "#22c55e", "1R"); add(o.tp2, "#22c55e", "2R");
  cs.setMarkers([{ time:o.barTime, position:o.direction === "achat" ? "belowBar" : "aboveBar", color:o.direction === "achat" ? "#22c55e" : "#ef4444",
    shape:o.direction === "achat" ? "arrowUp" : "arrowDown", text:o.setup }]);
  $("detail").innerHTML = `
    <div><b class="${o.direction === "achat" ? "buy" : "sell"}">${o.direction === "achat" ? "▲ Achat" : "▼ Vente"}</b> · ${esc(o.setup)} · score <b>${o.score}</b>/100</div>
    <div class="levels">
      <div>Entrée<b>${fmt(o.entry, o.symbol)}</b></div><div>Stop (1,5 ATR)<b style="color:var(--down)">${fmt(o.stop, o.symbol)}</b></div>
      <div>Objectif 1R<b style="color:var(--up)">${fmt(o.tp1, o.symbol)}</b></div><div>Objectif 2R<b style="color:var(--up)">${fmt(o.tp2, o.symbol)}</b></div>
    </div>
    <ul>${o.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
}

function liveCandle(sym, price, ts) {
  if (sym !== S.sym || !S.candles.length) return;
  const step = TF_SEC[S.tf], b = Math.floor(ts / step) * step, last = S.candles.at(-1);
  if (b < last.time) return;
  if (b === last.time) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
  else S.candles.push({ time:b, open:price, high:price, low:price, close:price });
  cs.update(S.candles.at(-1));
}

$("cSym").addEventListener("change", (e) => openChart(e.target.value, S.tf));
$("cTf").addEventListener("change", (e) => openChart(S.sym, e.target.value));

// ---------- Journal et alertes ----------
let alertsOn = false, audioCtx = null;
$("alertBtn").addEventListener("click", async () => {
  alertsOn = !alertsOn;
  if (alertsOn) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  }
  $("alertBtn").textContent = alertsOn ? "🔕 Désactiver les alertes" : "🔔 Activer les alertes";
});
function beep() {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = 880; g.gain.setValueAtTime(0.15, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
  o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.4);
}
function renderFeed() {
  $("feed").innerHTML = S.history.length ? S.history.slice(0, 60).map((o) => `
    <div><span class="muted">${new Date(o.detectedAt).toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" })}</span>
    <b>${esc(o.symbol)}</b> ${TF_LABEL[o.tf]} <span class="${o.direction === "achat" ? "buy" : "sell"}">${o.direction}</span> — ${esc(o.setup)} <span class="muted">(score ${o.score})</span></div>`).join("")
    : `<div class="muted">Aucune détection pour l'instant.</div>`;
}
function notify(o) {
  if (!alertsOn) return;
  const txt = `${o.symbol} ${TF_LABEL[o.tf]} — ${o.direction} · ${o.setup} (score ${o.score})`;
  beep();
  const t = document.createElement("div"); t.className = "toast"; t.textContent = "🎯 " + txt; document.body.appendChild(t); setTimeout(() => t.remove(), 6000);
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) new Notification("Opportunité forex", { body:txt });
}

// ---------- Connexion au serveur ----------
function setStatus(on, txt) { $("dot").className = "dot" + (on ? " on" : ""); $("statusTxt").textContent = txt; }

async function loadScanner() {
  const j = await api("/scanner");
  const first = !S.config;
  S.config = j.config; S.history = j.history;
  j.pairs.forEach((p) => (S.pairs[p.symbol] = p));
  $("modeTxt").textContent = j.config.mode === "websocket" ? "· prix en direct (WebSocket)"
    : `· mise à jour périodique · ${j.credits.today}${j.credits.dailyCap ? "/" + j.credits.dailyCap : ""} crédits aujourd'hui`;
  if (first) {
    const tfOpts = j.config.timeframes.map((t) => `<option value="${t}">${TF_LABEL[t]}</option>`).join("");
    $("fTf").innerHTML = `<option value="">Toutes</option>` + tfOpts; $("cTf").innerHTML = tfOpts;
    $("cSym").innerHTML = j.config.symbols.map((s) => `<option>${esc(s)}</option>`).join("");
    if (j.pairs.length) openChart(j.config.symbols[0], j.config.timeframes[0]);
  }
  renderPairs(); renderOpps(); renderFeed();
}

let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource(`${API_BASE}/stream?token=${encodeURIComponent(memSession.token)}`);
  es.onopen = () => setStatus(true, "Connecté");
  // en cas de coupure, on vérifie que la session est toujours valide
  es.onerror = () => { setStatus(false, "Reconnexion…"); api("/me").catch(() => {}); };
  es.addEventListener("tick", (e) => {
    const { symbol, price, ts } = JSON.parse(e.data);
    const prev = S.lastPx[symbol]; S.lastPx[symbol] = price;
    const el = $("px-" + symbol.replace("/", ""));
    if (el) { el.textContent = fmt(price, symbol); if (prev != null && prev !== price) { el.className = "px " + (price > prev ? "flash-up" : "flash-down"); setTimeout(() => (el.className = "px"), 600); } }
    liveCandle(symbol, price, ts);
  });
  es.addEventListener("pair", (e) => {
    const p = JSON.parse(e.data); const had = !S.pairs[p.symbol]; S.pairs[p.symbol] = p;
    if (S.selOpp && S.selOpp.symbol === p.symbol) {
      const upd = p.opportunities.find((o) => o.id === S.selOpp.id);
      if (upd) { S.selOpp = upd; drawOpp(); }
    }
    if (S.config) { renderPairs(); renderOpps(); if (had && !S.sym) openChart(p.symbol, S.config.timeframes[0]); }
  });
  es.addEventListener("opportunity", (e) => { const o = JSON.parse(e.data); S.history.unshift(o); renderFeed(); notify(o); });
}

// ---------- Connexion / déconnexion ----------
let refreshTimer = null;

async function startApp() {
  $("loginScreen").hidden = true; $("app").hidden = false;
  $("userTxt").textContent = "👤 " + memSession.user;
  try { await loadScanner(); }
  catch (e) { if (e instanceof AuthError) return; setStatus(false, "Serveur injoignable (il se réveille peut-être, patiente une minute)"); }
  connect();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadScanner().catch(() => {}), 60000);
}

function logout(message = "") {
  clearSession();
  if (es) { es.close(); es = null; }
  clearInterval(refreshTimer);
  $("app").hidden = true; $("loginScreen").hidden = false;
  $("loginErr").textContent = message;
  $("lPass").value = "";
}

$("logoutBtn").addEventListener("click", () => logout());

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn"); btn.disabled = true; btn.textContent = "Connexion…"; $("loginErr").textContent = "";
  try {
    const r = await fetch(API_BASE + "/login", { method:"POST", headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ username:$("lUser").value.trim(), password:$("lPass").value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Connexion impossible");
    saveSession({ token:j.token, user:j.user, expiresAt:j.expiresAt });
    $("lPass").value = "";
    startApp();
  } catch (err) {
    $("loginErr").textContent = err.message === "Failed to fetch"
      ? "Serveur injoignable. S'il était en veille, réessaie dans 30 secondes." : err.message;
  } finally { btn.disabled = false; btn.textContent = "Se connecter"; }
});

if (memSession) startApp(); else $("lUser").focus();
