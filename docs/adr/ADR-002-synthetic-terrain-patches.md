# ADR-002 — Terrain synthétique métrique, grille canonique et laboratoire isolé

Date : 2026-09-05. Statut : proposé dans la PR terrain, dépend d'ADR-001.

## Portée

Première tranche graphique V2 : 1, 4 ou 9 cellules statiques, sans provider réseau.
Le relief est **synthétique**, pas une reconstitution du lieu choisi. Les positions
terrestres, l'échelle, les ancrages et les raccords sont réels. Ni streaming, ni
physique, ni DEM/satellite réels, ni raccords de LOD différents ne sont livrés ici.
Le jeu racine et le workflow de production restent inchangés.

## Contrat géométrique

Les modules `v2/src/generation/terrain/` ne dépendent que du noyau géographique et
ne créent aucun objet Three.js. `v2/demo/render/` possède les ressources graphiques.
Une grille de N subdivisions a (N+1)^2 vertices. N est une puissance de deux entre
4 et 256. Le générateur de patches accepte les niveaux 15 à 24. Ces limites bornent
les allocations et l'étendue Float32 locale ; ce n'est pas une solution LOD globale.
Tout vertex à plus de 2048 m de son ancrage est refusé explicitement.

Pour cellule (L,x,y) et vertex (c,r), avec 0 <= c,r <= N :

```
e = L + log2(N)
Gx = x*N + c
Gy = y*N + r
u = (Gx modulo 2^e) / 2^e
v = Gy / 2^e
```

La clé de sample réduit simultanément les facteurs 2 de Gx, Gy et du dénominateur.
Les points des bords partagent donc la même clé, y compris +180°/-180° et les points
communs de grilles imbriquées. Cela ne prouve **pas** le stitching entre LOD.
Y ne boucle pas. Aux limites Mercator, les normales utilisent une différence à un
seul côté ; la couverture manquante n'est pas inventée.

Le cache LRU appartient à une seule source immuable et pure, limitée à 150000 samples.
Chaque source annonce `ELLIPSOIDAL_WGS84` et `synthetic`. NaN, infini, datum inconnu et
hauteurs hors domaine sont refusés. Le cache n'introduit aucune dépendance à l'ordre.

Le champ `flat` est h=0 sur l'ellipsoïde, et non un plan tangent infini. Le champ
`waves` est, en mètres, pour (X,Y,Z)=ECEF(longitude, latitude, h=0) :

```
h = 35 + 12 sin(X/180) + 8 sin(Y/240) cos(Z/300)
```

Il est continu dans l'espace global et indépendant des cellules. C'est une fonction
analytique de test, pas un DEM ni un algorithme de biome.

## Normales et orientation

Le halo utilise les positions ECEF globales. Les normales sont calculées par :

```
E = P(Gx+1,Gy) - P(Gx-1,Gy)
S = P(Gx,Gy+1) - P(Gx,Gy-1)
nECEF = normalize(S cross E)
nLocal = A * Rcell * nECEF
```

L'égalité des normales est testée à **LOD et pas d'échantillonnage identiques**.
Le maillage utilise le winding `(a,c,b),(b,c,d)` pour X Est / Y Haut / Z Sud.
Les UV valent `(c/N, 1-r/N)`. La texture quadrillée et ses coins colorés sont des
repères de diagnostic par cellule, pas de l'imagerie géoréférencée réelle.
Aucun skirt n'est utilisé pour dissimuler un défaut de raccord.

## Précision et mesures

Les points géodésiques/ECEF et ancrages restent en double précision. Les vertices
et normales locales sont convertis en Float32. Les buffers ne sont pas reconstruits
lors d'un déplacement de l'origine : seules les matrices des cellules, du repère
métrique, de la capsule et de la caméra sont transformées.

`measureTerrainSeams` distingue :
- l'écart entre vertices Float32 replacés par transformations CPU Float64 ;
- une **estimation** avec uniformes/opérations Float32 arrondis ;
- l'écart des normales et les clés de samples non concordantes.

L'estimation n'est ni une mesure GPU, ni une borne universelle : caméra, FMA du pilote,
rastérisation et profondeur ne sont pas tous reproduits. Le seuil de test de 1 mm
s'applique aux patches et origines proches testés, pas à une scène planétaire éloignée.
La précision numérique ne garantit pas la précision future des données d'un fournisseur.

## Démo et validation

La démo utilise Vite et Three.js déjà verrouillés au niveau racine : aucune nouvelle
dépendance runtime n'est ajoutée au noyau ou au jeu. Elle est compilée séparément,
sans dossier public legacy et sans secret, avec la base `/Zerana/v2/`.
La génération est synchrone et bornée pour ce laboratoire ; les workers viendront
avec le pipeline de streaming. On ne présente pas ces reconstructions comme fluides
pendant un déplacement de joueur.

La capsule de 1,80 m est un repère, sans contrôleur ni collider. La grille 5 m est
un plan tangent de debug, pas le terrain. Son léger offset graphique ne corrige
aucune coordonnée terrestre. Les matrices et buffers sont contrôlés séparément.

Tests : fixtures PROJ indépendantes, winding, UV, cache, indices Uint32, grille 3x3
à diverses latitudes, limites Mercator, antiméridien, ordre inversé, rebases de
buffers statiques. La CI exécute aussi Chromium/SwiftShader : chargement du build
sous son préfixe HTTP, 1/4/9 cellules, erreurs console/HTTP, absence de requêtes
externes, cycles de destruction, quatre déplacements d'origine et rejet de latitude.
Ces tests ne sont pas un benchmark matériel ni une preuve de stabilité longue durée.

## Références

- Architecture fournie : `../architecture/ZERANA_WORLD_ENGINE.md`, sections 4–8, 15 et 21.
- PROJ cartésien : https://proj.org/en/stable/operations/conversions/cart.html
- Three.js BufferGeometry : https://threejs.org/docs/pages/BufferGeometry.html
- Matrices et ordre des coefficients : https://threejs.org/docs/pages/Matrix4.html
- Vite et sous-chemins : https://vite.dev/guide/static-deploy.html
