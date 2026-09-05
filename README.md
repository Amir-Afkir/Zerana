# Zerana

Monde procédural basé sur des données géographiques réelles, rendu avec Three.js.

## Deux expériences séparées

- **Jeu historique** : `https://amir-afkir.github.io/Zerana/`, sources dans `src/`.
- **Laboratoire V2** : `https://amir-afkir.github.io/Zerana/v2/`, disponible après
  le déploiement combiné de l'étape 4. Ce n'est pas encore le monde jouable final.

`legacy/v1` conserve le prototype avec bâtiments/arbres et chemins Pages corrigés,
au commit `0e06c350b6c3d07699600e0003609790d60661c4`. La refonte ne remplace pas V1.

```sh
npm ci
npm run dev
```

Le token **public** Mapbox `VITE_MAPBOX_API_KEY` est configuré dans `.env.local`
en local, et dans l'environnement GitHub `Production` pour le build. Une variable
Vite embarquée est visible dans le JavaScript du navigateur : ne jamais utiliser
un token privé. La V2 démarre hors réseau ; Mapbox nécessite une action volontaire
et l'acceptation explicite des altitudes non certifiées.

## Développement et validation V2

Le noyau CPU TypeScript reste indépendant de Three.js et du navigateur. Le renderer
et les adaptateurs navigateur sont isolés dans `v2/demo/`. Node 22/24 en CI.

```sh
npm --prefix v2 ci
npm --prefix v2 run check
npm --prefix v2 run demo:dev
```

Pour construire le site combiné depuis un clone avec son historique :

```sh
node scripts/build-pages.mjs
```

Ce script vérifie les sources V1 contre la baseline et l'absence d'écrasement des
fichiers V1 après ajout de V2. Les lockfiles existants restent inchangés.
Le workflow `v2-ci.yml` ne déploie rien et n'utilise aucun secret de production.
Le workflow Pages ne publie que `main`, après tests et build combiné. Son contrôle
post-déploiement vérifie la version effectivement servie ; un build vert ne suffit pas.

## Références

- [Architecture normative fournie](docs/architecture/ZERANA_WORLD_ENGINE.md)
- [Historique des premières tranches](docs/REFONTE_STATUS.md)
- [Étape 3 : raster et altitudes](docs/REFONTE_STAGE3.md)
- [Étape 4 : préversion et état des validations](docs/REFONTE_STAGE4.md)
- [Décision d'isolation et de publication](docs/adr/ADR-004-isolated-public-preview.md)
- [Guide du noyau](v2/README.md)
- [Guide des providers](v2/demo/RASTER_PROVIDER_GUIDE.md)

La physique, le joueur V2, le streaming continu, le LOD mixte et la validation GPU
matérielle restent à développer. Les données Mapbox d'altitude restent étiquetées
`UNRESOLVED_DATUM_PREVIEW` ; elles ne sont pas silencieusement promues en WGS84 certifié.
