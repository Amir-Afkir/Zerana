# Étape 6 — première version du streaming

Cette tranche correspond au début du Milestone 5 de la référence. Elle ajoute
le renouvellement des cellules autour du joueur, pas encore le LOD mixte ou une
garantie de fluidité mondiale. La V1 reste à `/Zerana/`, la V2 à `/Zerana/v2/`.

## Essai sans fournisseur

Ouvrir la V2, sélectionner **Synthétique**, Paris, niveau 17 et 32 subdivisions.
Générer une ou neuf cellules, puis descendre au panneau **Monde continu**.
Cliquer sur **Activer le streaming**, puis sur **Marcher** dans le panneau joueur.
Les cellules apparaissent autour de la position réelle et les cellules éloignées
sont libérées. Les touches du joueur sont inchangées : flèches ou ZQSD/WASD,
Maj pour courir, Espace pour sauter, glisser la souris pour regarder, Échap pour pause.

Pour observer plus rapidement les changements : niveau 19, une cellule, profil
plat et réglage de streaming **20 m / 35 m — test rapproché**. Le rayon est bien
métrique ; il ne redimensionne ni les cellules ni le joueur.

Arrêter le streaming termine les workers, mais conserve le terrain déjà chargé.
Le patch de départ reste épinglé pour permettre la réapparition. Il compte dans
le plafond de 64 cellules. Le cache disque synthétique est optionnel et peut être
vidé ; son budget de charges comptabilisées est de 16 Mio.

## Essai Mapbox expérimental

Le chargement initial garde les règles précédentes : source Mapbox, token public
manuel ou celui du site, consentement pour les altitudes non certifiées, génération.
Activer ensuite le consentement séparé du streaming autorise **au maximum 256
requêtes supplémentaires par activation**, potentiellement facturables.
Le quota s'arrête proprement ; une réactivation explicite ouvre une nouvelle session.
Aucun appel automatique n'est effectué au simple chargement de la page.

Les tuiles Mapbox restent en cache mémoire uniquement. La surface conserve
`UNRESOLVED_DATUM_PREVIEW` et l'autorité `preview-only`. Marcher dessus ne certifie
pas ses altitudes. Les tests automatiques de cette tranche simulent les réponses
Mapbox : ils ne constituent pas une vérification du streaming sur des tuiles live.

## Contrôles et diagnostics

`window.__ZERANA_STREAM_DEBUG__` expose les clés résidentes, cellules épinglées,
états du scheduler, nombre de workers, octets en file/cache, quotas et temps maximal
d'intégration de cellule. Aucun token n'est inclus. Les diagnostics joueur/terrain
existants restent disponibles.

La suite ajoute 32 tests CPU aux 213 précédents. Le navigateur teste les vrais
workers, IndexedDB et entrées clavier, mais un fournisseur simulé. Les résultats
réels du commit, captures et preuves de livraison sont consignés dans la PR #6.

Depuis un checkout complet conservant l'historique de la baseline :

```sh
npm ci
npm ci --prefix v2 --ignore-scripts
npm --prefix v2 run check
node scripts/build-pages.mjs
python -m pip install -r v2/tests/browser/requirements.txt
python -m playwright install --with-deps chromium
python v2/tests/browser/streaming_smoke.py
```

## Limites qui restent ouvertes

Un seul niveau de détail par session ; pas encore de terrain parent de secours,
ni de livraison indépendante des couches terrain/imagerie. Le collider d'une nouvelle
cellule se construit encore sur le fil principal. Une admission par frame et un
seuil de démarrage de 4 ms ne garantissent pas un temps maximal de frame.
Les tests longs, le plateau mémoire global et les performances GPU matériel restent
à valider. Les routes, bâtiments et arbres restent des tranches suivantes.

Formules et contrats : [ADR-006](adr/ADR-006-streaming-and-cache.md).
