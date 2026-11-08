// Génère la ligne à mettre dans la variable USERS du serveur.
// Utilisation : node hash-password.js identifiant motdepasse
// Plusieurs comptes : sépare les lignes obtenues par des virgules dans USERS.

const crypto = require("crypto");
const [, , user, password] = process.argv;
if (!user || !password) {
  console.log("Utilisation : node hash-password.js identifiant motdepasse");
  process.exit(1);
}
if (user.includes(":") || user.includes(",")) { console.error("L'identifiant ne doit contenir ni « : » ni « , »."); process.exit(1); }
if (password.length < 10) console.warn("⚠️ Mot de passe court : 10 caractères minimum conseillés.");
const salt = crypto.randomBytes(16).toString("base64");
const hash = crypto.scryptSync(password, salt, 64).toString("base64");
console.log(`${user}:scrypt:${salt}:${hash}`);
