// Authentification de l'espace membres
// - comptes définis dans la variable USERS : "identifiant:scrypt:sel:hash,autre:scrypt:sel:hash"
//   (générés avec : node hash-password.js identifiant motdepasse)
// - jeton signé HMAC, valable SESSION_HOURS heures
// - limitation des tentatives de connexion par adresse IP

const crypto = require("crypto");

const SESSION_HOURS = +process.env.SESSION_HOURS || 12;
let SECRET = process.env.AUTH_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("⚠️ AUTH_SECRET absent : secret temporaire (les membres devront se reconnecter à chaque redémarrage).");
}

const users = new Map();
for (const entry of (process.env.USERS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  const [name, algo, salt, hash] = entry.split(":");
  if (algo !== "scrypt" || !salt || !hash) { console.error(`❌ Compte mal formé ignoré : ${name}`); continue; }
  users.set(name.toLowerCase(), { name, salt, hash });
}
if (!users.size) console.warn("⚠️ Aucun compte dans USERS : personne ne pourra se connecter.");
else console.log(`🔐 ${users.size} compte(s) membre(s) chargé(s)`);

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("base64");
  return { salt, hash };
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
function sign(data) { return crypto.createHmac("sha256", SECRET).update(data).digest("base64url"); }

function issueToken(user) {
  const exp = Date.now() + SESSION_HOURS * 3600000;
  const payload = b64u(JSON.stringify({ u: user, exp }));
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now() || !users.has(String(data.u).toLowerCase())) return null;
    return data.u;
  } catch { return null; }
}

// Limitation : 8 tentatives ratées par IP sur 15 minutes
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now(), list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, list);
  return list.length >= 8;
}
function recordFailure(ip) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(Date.now()); }
setInterval(() => { const now = Date.now(); for (const [ip, l] of attempts) if (!l.some((t) => now - t < 15 * 60000)) attempts.delete(ip); }, 600000);

function checkCredentials(username, password) {
  const u = users.get(String(username || "").toLowerCase());
  // calcul effectué même si l'identifiant n'existe pas (temps de réponse constant)
  const salt = u ? u.salt : "dummy-salt-value";
  const hash = crypto.scryptSync(String(password || ""), salt, 64);
  if (!u) return null;
  const ref = Buffer.from(u.hash, "base64");
  return ref.length === hash.length && crypto.timingSafeEqual(ref, hash) ? u.name : null;
}

module.exports = { hashPassword, issueToken, verifyToken, checkCredentials, tooManyAttempts, recordFailure };
