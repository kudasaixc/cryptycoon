# Cryptycoon

Simulation complète de trading crypto avec interface sombre type exchange, chandeliers, order book et bots concurrents.

## Fonctionnalités clés
- Difficultés Easy / Medium / Hard générant des patterns (falling wedge, fake breakout, ascending wedge) et mode Real-World avec prix réels rafraîchis toutes les 3 secondes.
- Modes de jeu EZ-Mode, Admin et Whale avec leviers modulables jusqu'à x200+ et soldes de départ adaptés.
- Order book en direct, conversions automatiques (USD -> autres fiats), liquidations en fonction du levier et faucet de secours.
- Leaderboard de 20 bots + vous, classement sur le PnL réalisé/unrealized et balance agrégée.
- Frontend React + TypeScript (Vite) en dark mode, backend Node/Express + Socket.IO sans base de données.

## Prérequis
- Node.js 18+

## Installation
```bash
npm install           # installe les dépendances racine (concurrently)
npm install --prefix server
npm install --prefix client
```

## Lancer le projet
Deux terminaux :
```bash
npm run dev --prefix server   # démarre le backend sur http://localhost:4000
npm run dev --prefix client   # démarre le frontend Vite sur http://localhost:5173
```

Ou bien une seule commande depuis la racine :
```bash
npm run dev
```

Le frontend attend le backend sur `http://localhost:4000`. Pour un serveur différent, créez `client/.env` avec :
```
VITE_SERVER_URL=http://votre-hote:4000
```

## Gameplay
1. Page de bienvenue → saisir votre nom, choisir difficulté et mode puis démarrer.
2. Sur le tableau de bord :
   - Graphique chandelier temps-réel, order book, PnL, solde agrégé.
   - Formulaire d'ordre (long/short, base/quote, levier jusqu'à x200). Conversion USD→EUR/TRY/… automatique si la quote manque.
   - Positions, liquidations et leaderboard en continu.
3. Le timer de 15 minutes tourne ; si vous êtes premier en PnL réalisé à la fin, vous gagnez et pouvez continuer ou relancer.
4. Si le solde tombe à 0, un faucet de 10 $ est disponible une seule fois.

## Notes
- Le mode Real-World interroge l'API publique de CoinGecko ; un accès réseau est requis. En cas d'échec, le jeu conserve le dernier snapshot.
- Aucun système de login n'est nécessaire : chaque session Socket.IO correspond à une partie.
