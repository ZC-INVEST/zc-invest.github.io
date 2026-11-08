# Scanner Forex — Espace membres ZC INVEST

```
www.zcinvest.co.uk/scanner/  ──login──▶  serveur scanner (Render)  ──▶  Twelve Data
   (page publique,                    (vérifie identifiant / mot de passe,
    aucune donnée sans connexion)      garde la clé API, analyse en continu)
```

- **Page** : `/scanner/` du site (lien « Espace membres » en haut et en bas du site).
- **Serveur** : ce dossier, à déployer sur Render (le `render.yaml` à la racine du dépôt le configure).
- Sans connexion valide, le serveur ne renvoie **aucune** donnée (prix, signaux, graphiques).

## 1. Déployer le serveur sur Render

1. Render → *New → Blueprint* → choisis le dépôt `ZC-INVEST/zc-invest.github.io`.
   Render lit `render.yaml` et crée le service **zc-scanner** (dossier `scanner-server/`).
2. Renseigne les deux variables demandées :
   - `TWELVEDATA_API_KEY` : ta clé Twelve Data
   - `USERS` : le ou les comptes membres (voir ci-dessous)
   `AUTH_SECRET` est généré automatiquement.
3. Note l'adresse du service, par ex. `https://zc-scanner.onrender.com`.
4. Si elle est différente, mets-la dans `scanner/config.js` :
   ```js
   window.SCANNER_API = "https://zc-scanner.onrender.com";
   ```
5. Vérifie `https://zc-scanner.onrender.com/health` → `"ok": true`.

## 2. Gérer les comptes membres

Les mots de passe ne sont jamais stockés en clair : seule une empreinte (scrypt) va dans `USERS`.

```bash
cd scanner-server
node hash-password.js nom_du_membre "MotDePasseSolide"
# → nom_du_membre:scrypt:xxxx:yyyy
```

- **Un compte** : `USERS=nom:scrypt:xxxx:yyyy`
- **Plusieurs comptes** : sépare les lignes par des virgules.
- **Retirer un accès** : supprime sa ligne dans `USERS` puis redémarre le service
  (sa session est refusée immédiatement).
- **Déconnecter tout le monde** : change `AUTH_SECRET`.

Sécurité intégrée : sessions de 12 h (`SESSION_HOURS`), 8 essais ratés max par IP
sur 15 min, comparaison des mots de passe à temps constant, CORS limité au site ZC INVEST.

## 3. Réglages du scanner

| Variable | Défaut | Rôle |
|---|---|---|
| `SYMBOLS` | `EUR/USD,GBP/USD,USD/JPY,XAU/USD` | paires surveillées |
| `TIMEFRAMES` | `15min,1h,4h` | unités de temps |
| `USE_WEBSOCKET` | `false` | `true` si le forfait Twelve Data inclut le WebSocket (Pro+) |
| `CREDITS_PER_MIN` / `DAILY_CREDITS` | `8` / `800` | quotas du forfait (`DAILY_CREDITS=0` si illimité) |
| `ALERT_MIN_SCORE` | `60` | score minimum d'une alerte |
| `ALLOWED_ORIGIN` | site ZC INVEST | sites autorisés à appeler le serveur |

En forfait gratuit, le serveur ralentit seul ses mises à jour pour tenir dans 800 crédits/jour
(scan « quasi temps réel », adapté au 1 h / 4 h). Avec le WebSocket, les prix sont en direct.

## Détection

Signaux évalués sur bougies clôturées : croisement EMA 20/50, croisement MACD,
pullback RSI dans la tendance, cassure du plus haut/bas des 20 bougies, retournement RSI.
Score /100 selon la tendance de l'unité de temps et de l'unité supérieure, le momentum,
la confluence ; stop à 1,5 ATR, objectifs à 1R et 2R.

## Limites

- Render gratuit met le serveur en veille après ~15 min sans visite : la première
  connexion prend 30 à 60 s. Pour un scan permanent : offre Starter.
- Les alertes fonctionnent tant que la page est ouverte.
- Outil d'analyse, pas un conseil en investissement.
