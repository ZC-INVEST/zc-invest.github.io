// Moteur d'analyse technique : indicateurs, tendance multi-unités de temps,
// détection de configurations (setups) et score d'opportunité.
// Les signaux sont évalués sur les bougies CLÔTURÉES pour éviter qu'ils
// apparaissent puis disparaissent pendant la formation de la bougie.

// ---------- Indicateurs ----------
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = val();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

function macd(values, fast = 12, slow = 26, sig = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const part = start < 0 ? [] : ema(line.slice(start), sig);
  const signal = line.map((_, i) => (start < 0 || i < start ? null : part[i - start]));
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

function atr(c, period = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length <= period) return out;
  const tr = c.map((x, i) => (i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < c.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
  return out;
}

function indicators(c) {
  const closes = c.map((x) => x.close);
  return {
    e20: ema(closes, 20), e50: ema(closes, 50), e200: ema(closes, 200),
    rsi: rsi(closes, 14), macd: macd(closes), atr: atr(c, 14),
  };
}

// ---------- Tendance ----------
// +1 haussière, -1 baissière, 0 indécise
function trendAt(c, ind, i) {
  const e20 = ind.e20[i], e50 = ind.e50[i];
  if (e20 == null || e50 == null) return 0;
  const base = ind.e200[i] ?? e50;
  if (c[i].close > base && e20 > e50) return 1;
  if (c[i].close < base && e20 < e50) return -1;
  return 0;
}

const crossUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) => crossUp(b, a, i);
const crossUpLevel = (a, lvl, i) => a[i - 1] != null && a[i] != null && a[i - 1] < lvl && a[i] >= lvl;
const crossDownLevel = (a, lvl, i) => a[i - 1] != null && a[i] != null && a[i - 1] > lvl && a[i] <= lvl;

// ---------- Détection des setups ----------
const LOOKBACK = 3; // un setup reste "actif" 3 bougies clôturées

function detectRaw(c, ind) {
  const out = [];
  const last = c.length - 2; // dernière bougie clôturée
  if (last < 60) return out;
  for (let age = 0; age < LOOKBACK; age++) {
    const i = last - age;
    const add = (setup, dir, counter = false) => out.push({ setup, dir, i, age, counter });

    if (crossUp(ind.e20, ind.e50, i)) add("Croisement EMA 20/50", 1);
    if (crossDown(ind.e20, ind.e50, i)) add("Croisement EMA 20/50", -1);

    if (crossUp(ind.macd.line, ind.macd.signal, i)) add("Croisement MACD", 1);
    if (crossDown(ind.macd.line, ind.macd.signal, i)) add("Croisement MACD", -1);

    const t = trendAt(c, ind, i);
    if (t === 1 && crossUpLevel(ind.rsi, 40, i)) add("Pullback RSI en tendance", 1);
    if (t === -1 && crossDownLevel(ind.rsi, 60, i)) add("Pullback RSI en tendance", -1);

    const win = c.slice(i - 20, i);
    const hh = Math.max(...win.map((x) => x.high)), ll = Math.min(...win.map((x) => x.low));
    if (c[i].close > hh && c[i - 1].close <= hh) add("Cassure plus haut 20 bougies", 1);
    if (c[i].close < ll && c[i - 1].close >= ll) add("Cassure plus bas 20 bougies", -1);

    if (crossUpLevel(ind.rsi, 30, i)) add("Rebond de survente (RSI)", 1, true);
    if (crossDownLevel(ind.rsi, 70, i)) add("Rejet de surachat (RSI)", -1, true);
  }
  return out;
}

// ---------- Analyse complète d'une paire ----------
// byTf : { "15min": [candles], "1h": [...], ... } ; tfs : ordre croissant des unités de temps
function analyzeSymbol(symbol, byTf, tfs, livePrice) {
  const frames = {};
  for (const tf of tfs) {
    const c = byTf[tf];
    if (!c || c.length < 62) continue;
    const ind = indicators(c);
    const n = c.length - 1;
    frames[tf] = { c, ind, trend: trendAt(c, ind, n), rsi: ind.rsi[n], atr: ind.atr[n] };
  }

  const lowest = tfs.find((tf) => frames[tf]);
  const price = livePrice ?? (lowest ? frames[lowest].c.at(-1).close : null);
  const opportunities = [];

  tfs.forEach((tf, idx) => {
    const f = frames[tf];
    if (!f) return;
    const htfName = tfs.slice(idx + 1).find((t) => frames[t]);
    const htf = htfName ? frames[htfName].trend : null;
    // un seul signal par configuration et par sens : le plus récent
    const keys = new Set();
    const raw = detectRaw(f.c, f.ind).filter((r) => {
      const k = `${r.setup}|${r.dir}`;
      if (keys.has(k)) return false;
      keys.add(k); return true;
    });

    for (const r of raw) {
      const { i, dir } = r;
      const a = f.ind.atr[i];
      if (!a) continue;
      let score = r.counter ? 35 : 45;
      const reasons = [];

      if (!r.counter) {
        const t = trendAt(f.c, f.ind, i);
        if (t === dir) { score += 15; reasons.push(`Dans le sens de la tendance ${tf}`); }
        else if (t === -dir) { score -= 15; reasons.push(`Contre la tendance ${tf}`); }
      } else reasons.push("Signal de retournement (contre-tendance)");

      if (htf != null) {
        if (htf === dir) { score += 20; reasons.push(`Confirmé par la tendance ${htfName}`); }
        else if (htf === -dir) { score -= 20; reasons.push(`Opposé à la tendance ${htfName}`); }
      }

      const h = f.ind.macd.hist[i];
      if (h != null && Math.sign(h) === dir) { score += 10; reasons.push("Momentum MACD favorable"); }

      const rv = f.ind.rsi[i];
      if ((dir > 0 && rv > 70) || (dir < 0 && rv < 30)) { score -= 10; reasons.push("RSI déjà extrême"); }
      else if (!r.counter) score += 5;

      score -= r.age * 5;
      const moved = ((price - f.c[i].close) * dir) / a;
      if (moved > 1) { score -= 15; reasons.push("Le prix est déjà parti (> 1 ATR)"); }

      const entry = price;
      opportunities.push({
        id: `${symbol}|${tf}|${r.setup}|${dir}|${f.c[i].time}`,
        symbol, tf, setup: r.setup,
        direction: dir > 0 ? "achat" : "vente",
        barTime: f.c[i].time, age: r.age,
        entry,
        stop: entry - dir * 1.5 * a,
        tp1: entry + dir * 1.5 * a,
        tp2: entry + dir * 3 * a,
        atr: a, reasons, score,
      });
    }
  });

  // Confluence : plusieurs setups dans le même sens sur la même UT
  for (const o of opportunities) {
    const same = opportunities.filter((x) => x !== o && x.tf === o.tf && x.direction === o.direction).length;
    if (same) { o.score += 10; o.reasons.push(`Confluence avec ${same} autre(s) signal(aux)`); }
    o.score = Math.max(0, Math.min(100, Math.round(o.score)));
  }
  opportunities.sort((a, b) => b.score - a.score);

  const trends = {};
  for (const tf of tfs) if (frames[tf]) trends[tf] = { trend: frames[tf].trend, rsi: frames[tf].rsi, atr: frames[tf].atr };
  const bias = Object.values(trends).reduce((s, t) => s + t.trend, 0);

  return { symbol, price, trends, bias, opportunities, analyzedAt: Date.now() };
}

module.exports = { ema, rsi, macd, atr, indicators, trendAt, detectRaw, analyzeSymbol };
