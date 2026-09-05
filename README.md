# Zerana

Monde procédural basé sur des données géographiques réelles, rendu avec Three.js.

## Version actuellement jouable

Le jeu existant reste dans `src/`. Son déploiement GitHub Pages n'est pas remplacé
par la première tranche V2. `legacy/v1` conserve le commit
`0e06c350b6c3d07699600e0003609790d60661c4` (prototype avec bâtiments, arbres et
corrections de chemins GitHub Pages).

```sh
npm ci
npm run dev
```

Le token public Mapbox est configuré localement dans `.env.local` via
`VITE_MAPBOX_API_KEY`, et dans l'environnement GitHub `Production` pour le build
Pages. Ne jamais committer un secret privé. Le secret du build Vite n'est pas
un mécanisme permettant de cacher une valeur embarquée dans le navigateur.

## Refonte V2 en cours

Le nouveau noyau est isolé dans `v2/`, sans dépendance d'exécution et sans import
Three.js. Il n'est pas encore branché au jeu publié.

```sh
npm --prefix v2 ci
npm --prefix v2 run check
```

Node.js 22 ou 24 est utilisé pour cette tranche. TypeScript est verrouillé par
le lockfile V2 ; les dépendances et le lockfile du jeu existant sont inchangés.

- [Référence d'architecture](docs/architecture/ZERANA_WORLD_ENGINE.md)
- [État réel de la refonte](docs/REFONTE_STATUS.md)
- [Guide du noyau](v2/README.md)
- [Décisions et précisions](docs/adr/ADR-001-v2-kernel-foundation.md)

Le workflow `v2-ci.yml` vérifie le noyau et compile également le jeu existant sous
le préfixe `/Zerana/`. Il ne déploie rien. Le workflow Pages existant reste réservé
à `main`. Un build vert ne prouve pas à lui seul qu'un jeu WebGL fonctionne.
