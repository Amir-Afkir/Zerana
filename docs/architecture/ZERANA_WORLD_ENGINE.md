# Zerana V2 — Référence d’architecture du moteur mondial Three.js

> **Statut :** document normatif  
> **Version :** 1.0.0  
> **Date :** 2 septembre 2026  
> **Projet :** Zerana  
> **Dépôt historique :** [Amir-Afkir/Zerana](https://github.com/Amir-Afkir/Zerana)  
> **Emplacement recommandé :** `docs/architecture/ZERANA_WORLD_ENGINE.md`

---

## Sommaire

1. [Vision produit](#1-vision-produit)
2. [Décisions structurantes](#2-décisions-structurantes)
3. [Glossaire et conventions](#3-glossaire-et-conventions)
4. [Noyau géospatial](#4-noyau-géospatial)
5. [Précision et origine flottante](#5-précision-et-origine-flottante)
6. [Découpage spatial du monde](#6-découpage-spatial-du-monde)
7. [Superposition des données](#7-superposition-des-données)
8. [Terrain continu et sans fissures](#8-terrain-continu-et-sans-fissures)
9. [Objets traversant les cellules](#9-objets-traversant-les-cellules)
10. [Génération procédurale](#10-génération-procédurale)
11. [Streaming du monde](#11-streaming-du-monde)
12. [Niveaux de détail](#12-niveaux-de-détail)
13. [Boucle de jeu et physique](#13-boucle-de-jeu-et-physique)
14. [Workers et pipeline asynchrone](#14-workers-et-pipeline-asynchrone)
15. [Rendu Three.js](#15-rendu-threejs)
16. [Cache](#16-cache)
17. [Configuration centrale](#17-configuration-centrale)
18. [Arborescence recommandée](#18-arborescence-recommandée)
19. [Communication entre modules](#19-communication-entre-modules)
20. [Debug et observabilité](#20-debug-et-observabilité)
21. [Tests obligatoires](#21-tests-obligatoires)
22. [Objectifs de performance](#22-objectifs-de-performance)
23. [Fournisseurs, secrets et licences](#23-fournisseurs-secrets-et-licences)
24. [Migration depuis Zerana V1](#24-migration-depuis-zerana-v1)
25. [Roadmap normative](#25-roadmap-normative)
26. [Règles de développement](#26-règles-de-développement)
27. [Definition of Done globale](#27-definition-of-done-globale)
28. [ADR à créer](#28-adr-à-créer)
29. [Risques principaux](#29-risques-principaux)
30. [Décisions encore ouvertes](#30-décisions-encore-ouvertes)
31. [Première tranche de travail concrète](#31-première-tranche-de-travail-concrète)
32. [Résumé exécutable](#32-résumé-exécutable)
33. [Décision finale](#33-décision-finale)

---

## 0. Rôle de ce document

Ce document définit l’architecture de référence de **Zerana V2** : un monde procédural basé sur des données géographiques réelles, rendu avec Three.js, dans lequel le joueur peut se déplacer continuellement sans limite de chargement visible.

Il sert de contrat commun pour :

- les mathématiques géospatiales ;
- la superposition du terrain, de l’imagerie et des données vectorielles ;
- le découpage du monde ;
- le streaming, le cache et les niveaux de détail ;
- la génération procédurale déterministe ;
- le rendu Three.js ;
- la physique, la caméra et le joueur ;
- les tests, les performances et les règles de contribution.

Le document utilise les termes normatifs suivants :

- **DOIT** : obligation ;
- **NE DOIT PAS** : interdiction ;
- **DEVRAIT** : recommandation forte ;
- **PEUT** : choix facultatif ;
- **MVP** : première version verticale validant l’architecture.

Toute exception à une règle marquée **DOIT** ou **NE DOIT PAS** doit être documentée dans un ADR, testée et approuvée avant fusion.

---

## 1. Vision produit

### 1.1 Expérience visée

Le joueur doit pouvoir :

1. choisir ou atteindre une position réelle sur Terre ;
2. apparaître à la bonne position géographique ;
3. se déplacer à une échelle humaine cohérente ;
4. traverser continuellement les cellules du monde ;
5. observer un terrain, des routes, des bâtiments, de l’eau et de la végétation alignés ;
6. conserver une expérience fluide malgré le chargement réseau et la génération ;
7. retrouver le même monde procédural lors d’une nouvelle session.

### 1.2 Principe fondamental

> **Une unité Three.js représente un mètre. Partout. Toujours.**

Conséquences :

- un joueur de 1,80 m mesure `1.80` unité ;
- une route de 6 m mesure `6` unités ;
- une maison de 9 m mesure `9` unités ;
- une vitesse de 5 m/s vaut `5` unités par seconde ;
- le joueur ne change jamais de taille en fonction de la latitude, d’une tile ou d’un chunk ;
- la projection géographique est responsable de l’échelle, pas l’avatar.

### 1.3 Ce que signifie « infini »

La Terre est finie. Dans Zerana, « déplacement infini » signifie :

- aucune carte entière n’est chargée en mémoire ;
- le monde actif suit continuellement le joueur ;
- les anciennes cellules sont déchargées ;
- les nouvelles cellules sont anticipées et chargées ;
- aucun bord artificiel n’est imposé dans la zone couverte par les fournisseurs ;
- lorsqu’une donnée réelle manque, une stratégie de repli évite un trou bloquant.

### 1.4 Hors périmètre initial

Le MVP ne cherche pas à résoudre immédiatement :

- le multijoueur ;
- la totalité des pôles avec une imagerie Mercator ;
- des façades photoréalistes exactes ;
- une physique complète de véhicules ;
- un backend planétaire ;
- l’import intégral de toutes les données OSM ;
- la destruction dynamique de toutes les structures.

Ces sujets doivent rester compatibles avec l’architecture, mais ne doivent pas retarder le noyau géospatial.

---

## 2. Décisions structurantes

### 2.1 Invariants non négociables

| Invariant | Conséquence |
|---|---|
| `1 unité = 1 mètre` | Échelle humaine stable |
| Position globale en double précision | Précision à l’échelle terrestre |
| Position GPU locale en simple précision | Three.js et le GPU restent stables |
| WGS84/ECEF comme vérité globale | Toutes les couches partagent le même référentiel |
| ENU local autour du joueur | Calculs, physique et rendu restent simples |
| Une cellule Zerana n’est pas une tile fournisseur | Chaque source garde son propre découpage |
| Une seule chaîne de transformation géographique | Pas de décalage entre terrain, routes et bâtiments |
| Les hauteurs déclarent leur référentiel vertical | Pas de mélange silencieux entre altitudes |
| Les bords de terrain partagent les mêmes échantillons | Pas de fissure structurelle |
| La génération utilise un seed stable | Le monde est reproductible |
| Les tâches asynchrones portent une révision | Aucun résultat obsolète ne réapparaît |
| Le parent reste visible pendant le chargement des enfants | Pas de trou lors d’un changement de LOD |
| Le thread principal ne réalise pas les traitements lourds | Framerate stable |
| Le rendu est seul propriétaire des ressources Three.js | Disposal fiable |
| Toute formule critique possède des tests indépendants | Les maths sont vérifiables |

### 2.2 Choix d’architecture

Zerana V2 démarre comme un **monolithe modulaire TypeScript**.

Ce choix facilite :

- l’installation ;
- le débogage ;
- les refactorings ;
- les tests ;
- l’apprentissage ;
- la livraison d’une première tranche verticale.

Le code peut être séparé en packages plus tard, mais les frontières logiques sont appliquées dès le premier jour.

### 2.3 Vue d’ensemble

```text
┌──────────────────────────────────────────────────────────────┐
│                         Application                          │
│        bootstrap, configuration, cycle de vie, debug         │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                           Runtime                            │
│      joueur, caméra, input, physique, boucle à pas fixe       │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                       World Streamer                         │
│  visibilité, priorité, LOD, révisions, cache, annulation      │
└───────────────┬──────────────────────────┬───────────────────┘
                │                          │
┌───────────────▼──────────────┐ ┌────────▼───────────────────┐
│       Data Providers        │ │   Procedural Generators     │
│ relief, imagerie, vecteurs   │ │ terrain, routes, bâtiments │
│ couverture et métadonnées    │ │ végétation, façades, props  │
└───────────────┬──────────────┘ └────────┬───────────────────┘
                │                          │
┌───────────────▼──────────────────────────▼───────────────────┐
│                    Canonical World Data                      │
│   coordonnées WGS84/ECEF, provenance, référentiels, IDs       │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                       Render / Three.js                       │
│ meshes, textures, instancing, uploads GPU, libération mémoire │
└──────────────────────────────────────────────────────────────┘

              Tous les modules utilisent le Geo Kernel
```

### 2.4 Direction des dépendances

```text
app
 ├── runtime
 ├── world
 ├── debug
 └── render

runtime  ──► geo, world
world    ──► geo, providers, generation, workers, cache
providers──► geo, données brutes
generation► geo, données canoniques
render   ──► Three.js, résultats de génération
geo      ──► aucune dépendance applicative
```

Interdictions :

- `geo/` NE DOIT PAS importer Three.js ;
- `providers/` NE DOIT PAS créer de `THREE.Mesh` ;
- `generation/` NE DOIT PAS accéder au DOM ou au réseau ;
- `render/` NE DOIT PAS décider quelles données géographiques charger ;
- `runtime/` NE DOIT PAS connaître Mapbox, OSM ou un fournisseur précis ;
- aucune dépendance circulaire n’est acceptée.

---

## 3. Glossaire et conventions

| Terme | Définition |
|---|---|
| WGS84 | Ellipsoïde et système géodésique global |
| Géodétique | Longitude, latitude et altitude |
| ECEF | Repère cartésien global centré sur la Terre |
| ENU | Repère tangent local East, North, Up |
| Origine flottante | Recentrage périodique du repère de rendu |
| Cellule | Unité Zerana de streaming et de génération |
| Tile fournisseur | Bloc de stockage d’une source |
| DEM | Modèle numérique d’élévation |
| LOD | Niveau de détail |
| SSE | Erreur projetée à l’écran en pixels |
| Provider | Adaptateur vers une source réelle |
| Generator | Transformation déterministe de données en contenu |
| Provenance | Origine, version et date d’une donnée |
| Révision | Numéro invalidant un résultat asynchrone ancien |
| Halo | Rangée d’échantillons située au-delà du bord d’une cellule |

### 3.1 Unités

Le noyau utilise :

- radians pour les angles internes ;
- mètres pour les distances et altitudes ;
- secondes pour le temps ;
- mètres par seconde pour les vitesses ;
- nombres JavaScript en double précision pour les coordonnées globales ;
- `Float32Array` pour les buffers GPU locaux.

Types marqués recommandés :

```ts
type Radians = number & { readonly __unit: 'radians' };
type Degrees = number & { readonly __unit: 'degrees' };
type Meters = number & { readonly __unit: 'meters' };
type Seconds = number & { readonly __unit: 'seconds' };

interface GeodeticPosition {
  longitudeRad: Radians;
  latitudeRad: Radians;
  ellipsoidHeightMeters: Meters;
}

interface EcefPosition {
  xMeters: Meters;
  yMeters: Meters;
  zMeters: Meters;
}
```

Les APIs publiques doivent expliciter l’unité dans le nom ou le type.

---

## 4. Noyau géospatial

Le Geo Kernel est une bibliothèque pure, testable sans navigateur et sans Three.js.

### 4.1 Constantes WGS84

```text
a  = 6 378 137 m
f  = 1 / 298.257223563
b  = a(1 − f)
e² = f(2 − f)
e'² = (a² − b²) / b²
```

Avec :

- `a` : demi-grand axe ;
- `b` : demi-petit axe ;
- `f` : aplatissement ;
- `e²` : première excentricité au carré ;
- `e'²` : seconde excentricité au carré.

Les constantes sont définies une seule fois dans `geo/wgs84.ts`.

### 4.2 Géodétique vers ECEF

Soient :

- `φ` la latitude géodétique ;
- `λ` la longitude ;
- `h` la hauteur ellipsoïdale ;
- `N(φ)` le rayon de courbure du premier vertical.

```text
N(φ) = a / √(1 − e² sin²φ)
```

Conversion :

```text
X = (N + h) cosφ cosλ
Y = (N + h) cosφ sinλ
Z = (N(1 − e²) + h) sinφ
```

Contrat :

```ts
function geodeticToEcef(position: GeodeticPosition): EcefPosition;
```

Cette fonction DOIT :

- accepter les longitudes normalisées ou non ;
- rejeter les valeurs non finies ;
- préserver la double précision ;
- ne jamais appliquer de projection Mercator.

### 4.3 ECEF vers géodétique

Définir :

```text
p = √(X² + Y²)
λ = atan2(Y, X)
```

Cas polaire, si `p` est inférieur à un epsilon :

```text
φ = signe(Z) × π/2
h = |Z| − b
```

Sinon, utiliser une initialisation de Bowring puis une itération :

```text
θ = atan2(Za, pb)

φ₀ = atan2(
  Z + e'² b sin³θ,
  p − e² a cos³θ
)
```

À l’itération `k` :

```text
Nₖ = a / √(1 − e² sin²φₖ)
hₖ = p / cosφₖ − Nₖ

φₖ₊₁ = atan2(
  Z,
  p × (1 − e² Nₖ / (Nₖ + hₖ))
)
```

Arrêt :

```text
|φₖ₊₁ − φₖ| < 10⁻¹² rad
```

ou après un nombre maximal documenté d’itérations.

Près des pôles, l’altitude peut être calculée avec :

```text
h = Z / sinφ − N(1 − e²)
```

pour éviter une division instable par `cosφ`.

Contrat :

```ts
function ecefToGeodetic(position: EcefPosition): GeodeticPosition;
```

Le round-trip ne suffit pas comme unique preuve : les tests doivent inclure des coordonnées de référence produites indépendamment.

### 4.4 Repère local ENU

Au point d’ancrage `(φ₀, λ₀)`, la matrice qui transforme un delta ECEF en ENU est :

```text
Renu =

[ -sinλ₀            cosλ₀           0      ]
[ -sinφ₀ cosλ₀     -sinφ₀ sinλ₀    cosφ₀  ]
[  cosφ₀ cosλ₀      cosφ₀ sinλ₀    sinφ₀  ]
```

Pour une position ECEF `P` et une origine ECEF `O` :

```text
Penu = Renu × (P − O)
```

Propriétés testées :

```text
Renu × Renuᵀ = I
det(Renu) = +1
```

Contrat :

```ts
interface GeoAnchor {
  geodetic: GeodeticPosition;
  ecef: EcefPosition;
  ecefToEnu: Float64Array; // matrice 3×3
}

function createGeoAnchor(origin: GeodeticPosition): GeoAnchor;
function ecefToEnu(point: EcefPosition, anchor: GeoAnchor): Float64Array;
function enuToEcef(point: Float64Array, anchor: GeoAnchor): EcefPosition;
```

### 4.5 Convention Three.js

Zerana utilise le repère droit suivant :

```text
Three X = Est
Three Y = Up
Three Z = Sud
```

À partir de l’ordre ENU `[E, N, U]` :

```text
Three = [E, U, −N]
```

Matrice de permutation :

```text
A =

[ 1   0   0 ]
[ 0   0   1 ]
[ 0  -1   0 ]
```

Transformation globale vers Three local :

```text
Pthree = A × Renu × (Pecef − Oecef)
```

Transformation inverse :

```text
Pecef = Oecef + Renuᵀ × Aᵀ × Pthree
```

Toutes les conversions vers une position Three.js DOIVENT passer par ces fonctions. Aucun module ne doit réimplémenter cette logique.

### 4.6 Repère local propre à une cellule

Chaque cellule possède un ancrage `C`.

Un vertex de la cellule est enregistré dans le repère Three local de cette cellule :

```text
Vcell = A × Rcell × (Pecef − Cecef)
```

Pour afficher cette géométrie dans le repère courant du monde, ancré en `O` :

```text
Vworld = Rotation × Vcell + Translation
```

avec :

```text
Rotation =
A × Rworld × Rcellᵀ × Aᵀ

Translation =
A × Rworld × (Cecef − Oecef)
```

Bénéfice : lors d’un recentrage, les buffers de vertices ne sont pas régénérés. Seule la transformation de la racine de cellule est recalculée.

### 4.7 Référentiels verticaux

Les hauteurs ne sont pas toutes de même nature.

Zerana distingue au minimum :

```ts
type VerticalReference =
  | 'ELLIPSOIDAL_WGS84'
  | 'ORTHOMETRIC_GEOID'
  | 'RELATIVE_TO_GROUND'
  | 'UNKNOWN';
```

Relation entre hauteur ellipsoïdale `h`, altitude orthométrique `H` et ondulation du géoïde `Ngeoïde` :

```text
h = H + Ngeoïde
```

Règles :

- un provider DOIT déclarer son référentiel vertical ;
- `UNKNOWN` NE DOIT PAS être mélangé silencieusement avec WGS84 ;
- les hauteurs absolues doivent être converties vers la référence canonique ;
- les hauteurs de bâtiments relatives au sol restent relatives au terrain ;
- l’absence de modèle de géoïde doit être visible dans les logs et le debug ;
- un décalage vertical global NE DOIT PAS être « corrigé à l’œil ».

### 4.8 Mouvement du joueur

La vérité du joueur est une pose géographique globale :

```ts
interface PlayerGeoState {
  ecefPosition: EcefPosition;
  velocityEcefMetersPerSecond: Float64Array;
  headingRad: Radians;
  pitchRad: Radians;
}
```

À chaque pas de physique :

1. calculer le déplacement dans le repère Three local ;
2. le convertir vers ENU avec `Aᵀ` ;
3. le convertir vers ECEF avec `Renuᵀ` ;
4. mettre à jour la position ECEF ;
5. convertir à nouveau vers géodétique lorsque nécessaire ;
6. corriger l’altitude à partir du terrain et de la capsule.

Pour un petit déplacement local `Δp` :

```text
Δecef = Renuᵀ × Aᵀ × Δp
Pecef_nouveau = Pecef_ancien + Δecef
```

Cette approximation tangentielle est valide pour les petits pas de simulation. Les téléportations et déplacements longue distance utilisent directement une position géodétique ou une résolution géodésique dédiée.

### 4.9 Distances

- Les distances de streaming proches utilisent le repère local ENU.
- Les distances globales ne doivent pas être calculées directement en degrés.
- Une distance euclidienne ECEF mesure une corde, pas une distance de surface.
- Les itinéraires mondiaux doivent passer par un service géodésique robuste.
- Les décisions de LOD utilisent la distance caméra-volume dans le repère local.

---

## 5. Précision et origine flottante

### 5.1 Modèle de précision

```text
Global :
  coordonnées ECEF en Float64
  vérité persistante et réseau

Local CPU :
  coordonnées ENU/Three proches de zéro
  nombres JavaScript en double précision

GPU :
  positions de vertices en Float32
  ancrées localement à chaque cellule
```

Les coordonnées terrestres de plusieurs millions de mètres ne doivent jamais être envoyées telles quelles aux buffers GPU.

### 5.2 Déclenchement du rebase

Le recentrage se déclenche lorsque :

```text
√(x² + z²) > rebaseDistanceMeters
```

dans le repère local courant.

Valeur initiale recommandée pour le MVP :

```text
rebaseDistanceMeters = 2048
```

Cette valeur est configurable et doit être validée par des tests de précision.

### 5.3 Transformation ancien repère vers nouveau repère

Pour un point local `Pold` :

```text
Pnew =
A Rnew (Oold − Onew)
+
A Rnew Roldᵀ Aᵀ Pold
```

Pour un vecteur sans position, par exemple une vitesse :

```text
Vnew =
A Rnew Roldᵀ Aᵀ Vold
```

Implémentation recommandée :

- les objets persistants conservent leur pose ECEF ;
- après rebase, leur pose locale est recalculée depuis ECEF ;
- la formule incrémentale sert principalement aux objets physiques temporaires ;
- les cellules recalculent leur transform depuis leur ancrage ;
- aucun vertex statique n’est modifié.

### 5.4 Transaction atomique

Le rebase DOIT avoir lieu :

1. entre deux pas de physique ;
2. avant le rendu de la frame ;
3. dans une transaction unique.

La transaction met à jour :

- l’ancrage courant ;
- le joueur ;
- la caméra ;
- les vitesses ;
- les objets dynamiques ;
- les colliders ;
- les racines des cellules ;
- les caches de matrices ;
- les outils de debug.

Invariants après rebase :

```text
position ECEF avant = position ECEF après
distance relative avant = distance relative après
vitesse physique avant = vitesse physique après, exprimée dans le nouveau repère
aucun saut visuel détectable
```

---

## 6. Découpage spatial du monde

### 6.1 Cellule Zerana et tile fournisseur

Une **cellule Zerana** est une unité de :

- visibilité ;
- génération ;
- cache ;
- LOD ;
- cycle de vie ;
- collision.

Une **tile fournisseur** est un bloc de stockage d’une source.

Une cellule peut dépendre de :

- plusieurs tiles d’imagerie ;
- plusieurs tiles d’élévation ;
- une requête vectorielle couvrant une zone plus large ;
- plusieurs niveaux de zoom fournisseur ;
- aucune tile si un fallback procédural est utilisé.

L’identité des deux concepts NE DOIT PAS être confondue.

### 6.2 Interface de schéma spatial

```ts
interface WorldCellId {
  scheme: string;
  level: number;
  x: number;
  y: number;
}

interface GeodeticBounds {
  westRad: Radians;
  southRad: Radians;
  eastRad: Radians;
  northRad: Radians;
  crossesAntimeridian: boolean;
}

interface WorldCellScheme {
  getCellAt(position: GeodeticPosition, level: number): WorldCellId;
  getBounds(id: WorldCellId): GeodeticBounds;
  getCenter(id: WorldCellId): GeodeticPosition;
  getNeighbors(id: WorldCellId): readonly WorldCellId[];
  getParent(id: WorldCellId): WorldCellId | null;
  getChildren(id: WorldCellId): readonly WorldCellId[];
  getStableKey(id: WorldCellId): string;
}
```

Le reste du moteur dépend de `WorldCellScheme`, jamais directement d’une formule Mercator.

### 6.3 Schéma initial

Le MVP utilise un quadtree Web Mercator, car il correspond naturellement aux sources raster courantes.

```ts
scheme = 'web-mercator'
```

Une future implémentation peut ajouter un cube-sphere pour les zones polaires sans modifier le streamer ni les générateurs.

### 6.4 Formules Web Mercator normalisées

Pour longitude `λ`, latitude `φ` et niveau `z` :

```text
u = (λ + π) / (2π)

v = 1/2 ×
    [1 − asinh(tanφ) / π]
```

avec :

```text
n = 2^z
tx = n × u
ty = n × v

tileX = floor(tx)
tileY = floor(ty)

fractionX = tx − tileX
fractionY = ty − tileY
```

Inverse :

```text
λ = 2πu − π
φ = atan(sinh(π(1 − 2v)))
```

Latitude maximale Mercator :

```text
φmax = atan(sinhπ)
≈ 85.05112878°
```

La longitude est normalisée par :

```text
normalize(λ) = ((λ + π) mod 2π + 2π) mod 2π − π
```

Le `x` d’une tile est cyclique :

```text
wrappedX = ((tileX mod n) + n) mod n
```

Le `y` est borné :

```text
0 ≤ tileY < n
```

### 6.5 Position exacte dans une cellule

Les fractions `fractionX` et `fractionY` DOIVENT être conservées.

Interdiction :

```ts
const x = Math.floor(...);
const y = Math.floor(...);
// puis oublier la position interne
```

Une adresse ou un joueur doit être placé à partir de ses coordonnées géodétiques exactes, pas au centre arbitraire de la cellule.

### 6.6 Taille réelle

Largeur approximative au sol d’une tile Mercator :

```text
Ltile(φ, z) ≈ 2πa cosφ / 2^z
```

Résolution au sol approximative pour une image de `W` pixels :

```text
resolution(φ, z, W) ≈
2πa cosφ / (W × 2^z)
```

Ces formules servent à :

- choisir un niveau fournisseur ;
- estimer une résolution ;
- planifier un budget.

Elles NE servent PAS à redimensionner le joueur ou les bâtiments.

La taille réelle finale d’une cellule est déterminée à partir de ses points WGS84 convertis en ECEF puis en ENU.

### 6.7 Identité stable

Clé canonique :

```text
{scheme}/{level}/{x}/{y}
```

Exemple :

```text
web-mercator/17/66321/45122
```

La clé est utilisée dans :

- le cache ;
- le scheduler ;
- le seed ;
- les logs ;
- le debug ;
- les tests.

---

## 7. Superposition des données

### 7.1 Référentiel canonique

Toutes les couches suivent la même chaîne :

```text
Source
  ↓
décodage dans son référentiel déclaré
  ↓
WGS84 géodétique + référentiel vertical explicite
  ↓
ECEF
  ↓
ENU local de la cellule
  ↓
repère Three.js de la cellule
```

Aucune source ne possède sa propre échelle Three.js.

### 7.2 Métadonnées obligatoires

```ts
interface DatasetMetadata {
  providerId: string;
  providerVersion: string;
  horizontalReference: string;
  verticalReference: VerticalReference;
  acquisitionDate?: string;
  licenseId?: string;
  attribution?: string;
  sourceZoom?: number;
}
```

### 7.3 Contrats providers

```ts
interface TerrainProvider {
  getCoverage(): CoverageDescriptor;

  fetchElevation(
    request: ElevationRequest,
    signal: AbortSignal
  ): Promise<ElevationDataset>;
}

interface ImageryProvider {
  getCoverage(): CoverageDescriptor;

  fetchImagery(
    request: ImageryRequest,
    signal: AbortSignal
  ): Promise<ImageryDataset>;
}

interface VectorProvider {
  getCoverage(): CoverageDescriptor;

  fetchFeatures(
    request: VectorRequest,
    signal: AbortSignal
  ): Promise<GeoFeatureCollection>;
}
```

Les providers retournent des données, jamais des objets Three.js.

### 7.4 Imagerie raster

L’imagerie d’une cellule est créée à partir de ses limites géographiques exactes.

Pipeline :

```text
bounds de cellule
  ↓
sélection des tiles source
  ↓
téléchargement et décodage
  ↓
reprojection/rééchantillonnage
  ↓
texture de cellule avec gutter
  ↓
upload GPU budgété
```

Règles :

- les UVs de terrain décrivent la cellule canonique, pas une tile source ;
- les pixels source sont interprétés par leur centre ;
- le rééchantillonnage près d’un bord doit accéder aux pixels voisins ;
- un gutter de texture évite les fuites de filtrage ;
- l’orientation `Y vers le sud` des tiles XYZ est traitée dans le provider ;
- la texture couleur est déclarée dans le bon espace colorimétrique ;
- aucun décalage d’un demi-pixel n’est corrigé manuellement dans le mesh.

Pour une coordonnée normalisée `u` dans une image de largeur `W`, si les pixels sont définis par leur centre :

```text
xpixel = uW − 1/2
```

Le provider est responsable des conventions précises de sa source.

### 7.5 Élévation raster

Règle absolue :

```text
RGB encodé
  ↓
décodage de chaque pixel en hauteur
  ↓
champ de hauteurs Float32/Float64
  ↓
rééchantillonnage des hauteurs
```

Interdiction :

```text
redimensionner/interpoler les couleurs RGB
  ↓
décoder ensuite
```

Pour un encodage Terrain-RGB classique :

```text
height =
−10000
+
0.1 × (R × 256² + G × 256 + B)
```

Interpolation bilinéaire de hauteurs :

```text
h(α, β) =
(1 − α)(1 − β)h00
+ α(1 − β)h10
+ (1 − α)βh01
+ αβh11
```

avec :

```text
0 ≤ α ≤ 1
0 ≤ β ≤ 1
```

### 7.6 Données vectorielles

Pour chaque feature :

1. décoder le CRS source ;
2. normaliser les longitudes ;
3. gérer l’antiméridien ;
4. densifier si un segment est trop long pour être assimilé à une ligne locale ;
5. convertir en WGS84 ;
6. appliquer un buffer de requête ;
7. clipper dans le repère local de la cellule ;
8. attribuer un propriétaire stable ;
9. générer la géométrie.

Les degrés ne sont jamais utilisés comme mètres.

### 7.7 Ordre de vérité

Ordre de priorité par défaut :

```text
1. donnée réelle explicite
2. donnée réelle dérivée
3. estimation contextuelle
4. génération procédurale
5. placeholder de sécurité
```

Une couche de priorité inférieure ne remplace jamais silencieusement une information plus fiable.

Chaque valeur dérivée importante peut conserver :

```ts
interface ProvenancedValue<T> {
  value: T;
  source: 'observed' | 'derived' | 'estimated' | 'procedural' | 'fallback';
  confidence: number;
  providerId?: string;
}
```

---

## 8. Terrain continu et sans fissures

### 8.1 Grille canonique

Une cellule au niveau `L` utilise `N × N` subdivisions, donc `(N + 1)²` sommets.

Coordonnées globales de l’échantillon :

```text
Gx = cellX × N + localX
Gy = cellY × N + localY
```

Coordonnées normalisées :

```text
u = Gx / (N × 2^L)
v = Gy / (N × 2^L)
```

Le bord droit de A et le bord gauche de B utilisent le même `Gx`.

```text
A.Gx_droit = B.Gx_gauche
```

Ils doivent donc produire la même coordonnée géodétique et la même hauteur.

### 8.2 Clé d’échantillon

```ts
interface TerrainSampleKey {
  level: number;
  globalX: number;
  globalY: number;
}
```

Pour partager des samples entre plusieurs LOD, la fraction peut être réduite en supprimant les facteurs de deux communs. Les samples parents deviennent ainsi un sous-ensemble des samples enfants.

Le cache de samples est partagé entre cellules voisines.

### 8.3 Halo

Chaque cellule demande au minimum un halo d’un échantillon autour de sa grille.

Le halo sert à :

- calculer des normales par différences centrales ;
- éviter un éclairage discontinu ;
- interpoler près des bords ;
- construire des colliders cohérents.

Différences centrales :

```text
∂h/∂x ≈ [h(x + Δx) − h(x − Δx)] / (2Δx)
∂h/∂z ≈ [h(z + Δz) − h(z − Δz)] / (2Δz)
```

Une normale locale non normalisée peut être formée par :

```text
n = [−∂h/∂x, 1, −∂h/∂z]
```

puis normalisée.

Sur de grandes cellules courbes, les normales doivent être calculées à partir des positions 3D ECEF/ENU plutôt qu’avec une hypothèse plane simpliste.

### 8.4 Construction du mesh

Pour chaque sample :

1. obtenir `(u, v)` canonique ;
2. convertir `(u, v)` vers longitude/latitude ;
3. échantillonner l’altitude canonique ;
4. convertir en ECEF ;
5. convertir dans l’ENU de la cellule ;
6. permuter vers le repère Three local ;
7. enregistrer en `Float32Array`.

Le terrain suit ainsi naturellement :

- la vraie échelle locale ;
- la courbure ;
- la latitude ;
- l’altitude ;
- les limites exactes de la cellule.

### 8.5 Skirts

Les skirts PEUVENT être conservés comme filet visuel.

Ils NE DOIVENT PAS remplacer :

- le partage des samples ;
- le stitching de LOD ;
- le geomorphing ;
- les tests de continuité.

### 8.6 Collisions terrain

La collision proche utilise une représentation indépendante du LOD visuel.

Règles :

- la zone physique est plus petite que la zone visible ;
- les colliders sont créés en priorité ;
- le joueur ne doit jamais marcher sur une cellule uniquement décorative ;
- une cellule de sécurité basse résolution reste disponible sous le joueur ;
- le changement de collider est réalisé entre deux pas fixes ;
- le sol ne doit pas « popper » verticalement sous le joueur.

### 8.7 Tolérance de raccord

Pour deux cellules voisines de même LOD :

```text
max distance des vertices de bord < 1 mm
```

dans le repère global local.

La valeur ciblée côté calcul double précision doit être plus stricte :

```text
< 10⁻⁶ m lorsque les samples sont censés être identiques
```

---

## 9. Objets traversant les cellules

### 9.1 Bâtiments

Un bâtiment possède un propriétaire unique.

```text
homeCell = cellContaining(stableCentroid)
```

Le bâtiment n’est généré qu’une fois.

La cellule propriétaire reste résidente si la bounding box du bâtiment intersecte la zone visible.

Pour un objet sans ID source fiable :

```text
stableId =
hash(
  géométrie normalisée,
  type,
  source,
  version
)
```

### 9.2 Routes et rivières

Les lignes peuvent être découpées par cellule, mais :

- leur géométrie source est globale ;
- les points de coupe sont déterministes ;
- les tangentes au bord sont partagées ;
- les largeurs sont exprimées en mètres ;
- les jonctions utilisent des IDs stables ;
- les extrémités ne sont pas générées deux fois.

### 9.3 Eau et landcover

Les polygones sont :

1. récupérés avec une marge ;
2. convertis vers le repère local ;
3. clippés par cellule ;
4. triangulés de manière déterministe ;
5. assemblés avec un léger recouvrement ou une bordure maîtrisée si nécessaire.

### 9.4 Bâtiments sur le relief

Pour un petit bâtiment :

```text
Hbase = médiane(Hterrain aux points d’appui)
```

Le plancher reste horizontal et des fondations comblent l’espace jusqu’au terrain.

Pour un grand bâtiment, un plan peut être ajusté par moindres carrés :

```text
y = αx + βz + γ
```

en minimisant :

```text
Σ [yi − (αxi + βzi + γ)]²
```

avec contrainte de pente :

```text
√(α² + β²) ≤ tan(θmax)
```

La stratégie choisie dépend de la classe du bâtiment.

---

## 10. Génération procédurale

### 10.1 Déterminisme

Aucun générateur NE DOIT utiliser directement `Math.random()`.

Seed canonique :

```text
seed =
hash(
  worldSeed,
  cellStableKey,
  featureStableId,
  generatorName,
  generatorVersion
)
```

Le PRNG utilisé doit être :

- explicitement choisi ;
- versionné ;
- testé ;
- indépendant de l’ordre de chargement.

### 10.2 Deux niveaux de déterminisme

**Déterminisme d’identité**, obligatoire :

- mêmes objets ;
- mêmes IDs ;
- mêmes choix de matériaux ;
- mêmes nombres d’étages ;
- mêmes seeds.

**Déterminisme binaire**, facultatif mais utile :

- mêmes buffers octet par octet.

Le déterminisme binaire exige :

- un PRNG entier stable ;
- des tris explicites ;
- l’absence d’itérations non ordonnées ;
- des algorithmes numériques maîtrisés ;
- éventuellement du fixed-point pour certaines étapes.

Les fonctions transcendantes peuvent introduire de minuscules différences entre environnements. Les tests géométriques doivent donc utiliser une tolérance lorsqu’un chemin n’est pas strictement entier.

### 10.3 Générateurs purs

```ts
interface GenerationContext {
  worldSeed: bigint;
  cellId: WorldCellId;
  generatorVersion: string;
  geoAnchor: GeoAnchor;
}

type Generator<TInput, TOutput> = (
  input: Readonly<TInput>,
  context: Readonly<GenerationContext>
) => TOutput;
```

Un générateur pur :

- ne télécharge rien ;
- n’accède pas au DOM ;
- ne modifie pas un singleton ;
- ne dépend pas de l’heure ;
- ne dépend pas de l’ordre de chargement ;
- retourne des données sérialisables ou transférables.

### 10.4 Continuité globale

Mauvais :

```ts
noise(localX, localZ);
```

Correct :

```ts
noise3D(
  ecefX / wavelengthMeters,
  ecefY / wavelengthMeters,
  ecefZ / wavelengthMeters
);
```

Le bruit est échantillonné dans un espace global continu.

Terrain enrichi :

```text
hfinal(P) =
hDEM(P)
+
mask(P) × amplitude(P) × noiseECEF(P / longueurOnde)
```

La `mask(P)` réduit ou annule le bruit :

- sous les routes ;
- sous les bâtiments ;
- sur l’eau ;
- sur les zones planes ;
- près des ouvrages sensibles.

### 10.5 Pipeline procédural recommandé

```text
données réelles normalisées
  ↓
résolution régionale
  ↓
contraintes spatiales
  ↓
terrain de détail
  ↓
routes et eau
  ↓
bâtiments
  ↓
architecture régionale
  ↓
végétation
  ↓
mobilier et props
  ↓
optimisation LOD/instancing
```

### 10.6 Architecture régionale

Le résolveur régional produit un contexte, pas directement des meshes.

```ts
interface RegionalStyleContext {
  regionId: string;
  climateClass?: string;
  urbanDensity?: number;
  materialPalette: readonly string[];
  roofRules: RoofRuleSet;
  facadeRules: FacadeRuleSet;
  vegetationRules: VegetationRuleSet;
}
```

Les informations réelles priment. Les valeurs absentes sont estimées puis générées de façon déterministe.

### 10.7 Fallback procédural

Lorsqu’une donnée réelle manque :

- terrain : DEM plus grossier, puis terrain procédural de sécurité ;
- imagerie : matériaux landcover ou palette régionale ;
- bâtiments : absence assumée ou génération guidée par densité, jamais imitation présentée comme exacte ;
- végétation : génération par biome/landcover ;
- eau : ne pas inventer une étendue majeure sans signal source ;
- collision : terrain de sécurité obligatoire.

Le debug doit distinguer visuellement le réel, l’estimé et le procédural.

---

## 11. Streaming du monde

### 11.1 Fenêtres concentriques

Le streamer travaille en mètres.

```ts
interface StreamingConfig {
  visibleRadiusMeters: number;
  retentionRadiusMeters: number;
  physicsRadiusMeters: number;
  predictionSeconds: number;
  rebaseDistanceMeters: number;
}
```

Invariants :

```text
physicsRadius < visibleRadius < retentionRadius
```

Rôles :

- **physics** : terrain et collisions jouables ;
- **visible** : contenu affiché ;
- **retention** : contenu conservé pour éviter le thrashing ;
- **prefetch** : cellules anticipées devant le joueur.

### 11.2 Position prédite

```text
Pprédit =
Pjoueur
+
Vjoueur × predictionSeconds
```

La vitesse est filtrée afin d’éviter qu’un petit changement de direction ne vide constamment la file.

### 11.3 Cycle de vie d’une cellule

```text
ABSENT
  ↓
QUEUED
  ↓
FETCHING
  ↓
DECODING
  ↓
GENERATING
  ↓
CPU_READY
  ↓
GPU_QUEUED
  ↓
VISIBLE
  ↓
RETAINED
  ↓
EVICTING
  ↓
ABSENT
```

États d’erreur :

```text
FETCH_ERROR
DECODE_ERROR
GENERATION_ERROR
GPU_ERROR
```

Chaque erreur possède :

- une catégorie ;
- un nombre de tentatives ;
- une prochaine date de retry ;
- un fallback ;
- un diagnostic.

### 11.4 Révision et annulation

```ts
interface CellRuntimeState {
  id: WorldCellId;
  stableKey: string;
  revision: number;
  status: CellStatus;
  abortController: AbortController;
  requestedLayers: number;
  readyLayers: number;
}
```

À chaque nouvelle demande incompatible :

```text
revision = revision + 1
abort ancienne tâche
```

À la réception :

```ts
if (result.revision !== state.revision) {
  disposeResult(result);
  return;
}
```

Aucun résultat obsolète ne doit atteindre la scène.

### 11.5 Chargement progressif

Une cellule n’attend pas obligatoirement toutes les couches.

Ordre de service recommandé :

```text
1. terrain basse résolution
2. collider
3. terrain visuel cible
4. imagerie
5. routes et eau
6. bâtiments
7. végétation
8. props
```

Une cellule peut avoir plusieurs niveaux de disponibilité :

```ts
enum CellReadiness {
  None = 0,
  SafeTerrain = 1 << 0,
  Physics = 1 << 1,
  VisualTerrain = 1 << 2,
  Imagery = 1 << 3,
  Vectors = 1 << 4,
  Buildings = 1 << 5,
  Decoration = 1 << 6,
}
```

### 11.6 Classes de priorité

Utiliser d’abord une priorité lexicographique :

```text
classe 0 : sécurité sous le joueur
classe 1 : collision imminente
classe 2 : trou visible
classe 3 : zone visible
classe 4 : préchargement directionnel
classe 5 : décoration
classe 6 : cache opportuniste
```

À l’intérieur d’une classe :

```text
D = clamp(distancePrédite / rayon, 0, 1)

F = [1 − clamp(forward · directionCell, −1, 1)] / 2

V = [1 − clamp(velocityDirection · directionCell, −1, 1)] / 2

A = clamp(waitingTime / maxWaitingTime, 0, 1)
```

Score :

```text
score =
wdD
+
wfF
+
wvV
−
waA
```

Plus le score est faible, plus la tâche est prioritaire.

En cas d’égalité, utiliser la clé stable de cellule. Le résultat ne dépend ainsi pas d’un ordre aléatoire.

### 11.7 Backpressure

Le streamer impose des limites :

```ts
interface PipelineBudgets {
  maxNetworkRequests: number;
  maxDecodeTasks: number;
  maxGenerationTasks: number;
  maxGpuUploadsPerFrame: number;
  maxQueuedBytes: number;
}
```

Le scheduler NE DOIT PAS continuer à télécharger si :

- la file CPU est saturée ;
- la mémoire dépasse le seuil ;
- la file GPU est trop longue ;
- la cellule n’est plus utile.

### 11.8 Résilience réseau

Chaque requête possède :

- timeout ;
- annulation ;
- retry exponentiel borné ;
- classification des erreurs ;
- fallback ;
- cache stale-while-revalidate si autorisé.

Une panne réseau ne doit pas faire disparaître le terrain déjà visible.

---

## 12. Niveaux de détail

### 12.1 Erreur géométrique

Chaque représentation possède une erreur maximale en mètres :

```text
ε = max ||PhauteRésolution − PLOD||
```

Pour un terrain uniquement vertical, une approximation peut utiliser :

```text
εh = max |hhauteRésolution − hLOD|
```

### 12.2 Screen-Space Error

Pour :

- erreur géométrique `ε` ;
- hauteur viewport `Hpx` ;
- distance caméra-volume `d` ;
- champ vertical `fovY` ;

```text
SSEpx =
ε × Hpx
────────────────────────────
2d × tan(fovY / 2)
```

Décision :

```text
SSE > refineThreshold  → demander les enfants
SSE < mergeThreshold   → autoriser le parent
```

Avec :

```text
mergeThreshold < refineThreshold
```

Cette hystérésis évite le clignotement.

### 12.3 Quadtree et transitions

Règle de visibilité :

```text
parent visible
  ↓
chargement des enfants
  ↓
tous les enfants nécessaires sont CPU/GPU prêts
  ↓
transition
  ↓
parent masqué
```

Interdiction :

```text
masquer parent
  ↓
attendre réseau
  ↓
trou
```

### 12.4 Différence de LOD entre voisins

Les voisins visibles devraient différer d’au maximum un niveau.

Solutions de raccord :

1. indices de stitching ;
2. geomorphing ;
3. bordures emboîtées ;
4. skirts en dernier recours.

### 12.5 LOD par couche

Le LOD terrain ne doit pas imposer le même LOD à tout.

Exemples :

- terrain : erreur géométrique ;
- bâtiments : distance, taille écran, importance ;
- végétation : impostors puis culling ;
- routes : largeur écran ;
- props : distance et densité ;
- collisions : rayon physique, indépendamment du rendu.

### 12.6 Gestionnaire de qualité adaptatif

Le moteur mesure :

- frame time CPU ;
- frame time GPU si disponible ;
- taille des files ;
- mémoire estimée ;
- débit réseau ;
- vitesse du joueur.

Il ajuste progressivement :

- rayon visible ;
- résolution terrain ;
- résolution textures ;
- densité de végétation ;
- distance des ombres ;
- nombre d’uploads ;
- seuil SSE.

Les changements doivent avoir une hystérésis pour éviter les oscillations.

---

## 13. Boucle de jeu et physique

### 13.1 Pas fixe

```ts
const fixedStepSeconds = 1 / 60;
let accumulator = 0;

function frame(frameDeltaSeconds: number): void {
  const clamped = Math.min(frameDeltaSeconds, 0.1);
  accumulator += clamped;

  while (accumulator >= fixedStepSeconds) {
    simulateFixedStep(fixedStepSeconds);
    accumulator -= fixedStepSeconds;
  }

  const alpha = accumulator / fixedStepSeconds;
  renderInterpolated(alpha);
}
```

Bénéfices :

- vitesse indépendante des FPS ;
- collisions stables ;
- replays plus fiables ;
- intégration géographique contrôlée.

### 13.2 Source de vérité unique

Il n’existe qu’un seul joueur logique.

```text
PlayerGeoState
  ├── vérité ECEF
  ├── pose locale dérivée
  ├── collider local
  └── mesh visuel local
```

Interdits :

- un `stubPlayer` pour le streaming ;
- un autre joueur pour le rendu ;
- une troisième position pour la physique.

### 13.3 Caméra

La caméra utilise des distances en mètres.

```ts
interface CameraConfig {
  nearMeters: number;
  farMeters: number;
  followDistanceMeters: number;
  targetHeightMeters: number;
}
```

Le `near` doit rester aussi grand que raisonnablement possible pour préserver la précision du depth buffer.

Le `far` ne doit pas être fixé à une valeur planétaire. Les objets lointains sont gérés par LOD, culling, brouillard atmosphérique ou passes spécifiques.

### 13.4 Physique

La physique est derrière une interface :

```ts
interface PhysicsWorld {
  step(deltaSeconds: number): void;
  rebase(transform: LocalFrameTransform): void;
  addCollider(packet: ColliderPacket): ColliderHandle;
  removeCollider(handle: ColliderHandle): void;
}
```

Le moteur peut changer d’implémentation sans modifier le Geo Kernel ou le streamer.

---

## 14. Workers et pipeline asynchrone

### 14.1 Responsabilités

Thread principal :

- input ;
- pas de physique ;
- scheduling léger ;
- transformations ;
- petits changements de scène ;
- uploads GPU budgétés ;
- rendu.

Workers :

- décodage DEM ;
- rééchantillonnage ;
- génération terrain ;
- clipping vectoriel ;
- triangulation ;
- génération bâtiments ;
- génération végétation ;
- simplification LOD ;
- calcul de bounding volumes.

### 14.2 Paquets transférables

```ts
interface MeshPacket {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  bounds: LocalBounds;
}

interface InstanceGroupPacket {
  geometryKey: string;
  materialKey: string;
  matrices: Float32Array;
  count: number;
}

interface CellBuildResult {
  cellId: WorldCellId;
  revision: number;
  anchor: GeoAnchor;
  terrain?: MeshPacket;
  opaqueMeshes: readonly MeshPacket[];
  transparentMeshes: readonly MeshPacket[];
  instanceGroups: readonly InstanceGroupPacket[];
  colliders: readonly ColliderPacket[];
  dependencies: readonly SourceCacheKey[];
}
```

Les buffers sont transmis avec `postMessage(..., transferList)`.

### 14.3 Worker pool

Taille recommandée :

```text
workerCount =
clamp(hardwareConcurrency − 2, minimum, maximum)
```

La valeur exacte est configurable.

La file distingue :

- latence critique ;
- terrain visible ;
- vecteurs visibles ;
- préfetch ;
- décoration.

### 14.4 Upload GPU budgété

```ts
while (
  uploadQueue.hasItems() &&
  performance.now() - frameStart < gpuUploadBudgetMs
) {
  uploadQueue.uploadNext();
}
```

Aucune frame ne doit construire brutalement des dizaines de meshes lourds.

---

## 15. Rendu Three.js

### 15.1 Règle de propriété

Seul `render/` crée et détruit :

- `THREE.BufferGeometry` ;
- `THREE.Material` ;
- `THREE.Texture` ;
- `THREE.InstancedMesh` ;
- render targets ;
- objets de scène.

Le monde et les générateurs ne manipulent que des paquets de données.

### 15.2 Racines de scène

```text
scene
├── worldRoot
│   ├── terrainRoot
│   ├── structuresRoot
│   ├── vegetationRoot
│   └── waterRoot
├── dynamicRoot
│   ├── player
│   └── entities
├── effectsRoot
└── debugRoot
```

Chaque cellule possède une racine transformée depuis son `GeoAnchor`.

### 15.3 Resource Registry

```ts
interface ResourceHandle<T> {
  key: string;
  resource: T;
  release(): void;
}

interface ResourceRegistry {
  acquireGeometry(key: string, factory: () => THREE.BufferGeometry):
    ResourceHandle<THREE.BufferGeometry>;

  acquireMaterial(key: string, factory: () => THREE.Material):
    ResourceHandle<THREE.Material>;

  acquireTexture(key: string, factory: () => THREE.Texture):
    ResourceHandle<THREE.Texture>;
}
```

Le registry utilise des références comptées.

Retirer un objet de la scène n’est pas suffisant.

Il faut libérer :

- geometry ;
- material ;
- textures ;
- ImageBitmap ;
- render targets ;
- instance buffers ;
- colliders ;
- listeners ;
- timers ;
- worker tasks.

### 15.4 Instancing et batching

Utiliser l’instancing pour :

- arbres ;
- rochers ;
- mobilier répété ;
- fenêtres ou modules répétitifs ;
- bâtiments simples partageant un modèle.

Le batching ne doit pas empêcher :

- le culling ;
- le remplacement de LOD ;
- la libération par zone ;
- l’identification debug.

La granularité optimale est généralement la cellule ou un petit groupe de cellules, pas le monde entier.

### 15.5 Culling

Ordre recommandé :

1. frustum culling ;
2. distance/LOD ;
3. culling par cellule ;
4. occlusion optionnelle ;
5. désactivation des ombres lointaines.

---

## 16. Cache

### 16.1 Niveaux

```text
L1 — mémoire
  données visibles et récemment utilisées

L2 — IndexedDB
  réponses réseau, données décodées, paquets générés utiles

L3 — backend/CDN optionnel
  données mutualisées et prétraitées
```

### 16.2 Clé

```text
providerId
/providerVersion
/horizontalReference
/verticalReference
/cellScheme
/cellId
/sourceLod
/generatorName
/generatorVersion
/worldSeed
```

Exemple :

```text
terrain/provider-v3/EPSG4979/ellipsoid/web-mercator/17/66321/45122/lod2/terrain-v4/42
```

### 16.3 Invalidation

Le cache est invalidé lorsqu’un élément change :

- version provider ;
- formule de décodage ;
- référentiel vertical ;
- schéma de cellule ;
- version du générateur ;
- seed mondial ;
- format de paquet ;
- politique de LOD.

### 16.4 Budgets mémoire

```ts
interface MemoryBudgets {
  sourceBytes: number;
  decodedElevationBytes: number;
  geometryBytes: number;
  textureBytes: number;
  instanceBytes: number;
  physicsBytes: number;
}
```

Le cache L1 utilise un LRU pondéré par la taille.

Priorité de conservation :

```text
1. zone physique
2. visible
3. parent de secours
4. rétention
5. préfetch
6. décoration régénérable
```

### 16.5 Données régénérables

Les données procédurales bon marché peuvent être régénérées au lieu d’être persistées.

Les réponses réseau coûteuses sont prioritaires pour le cache persistant, sous réserve des licences.

---

## 17. Configuration centrale

Aucun nombre magique dans les modules.

```ts
interface WorldConfig {
  unitsPerMeter: 1;

  geo: {
    rebaseDistanceMeters: number;
    mercatorMaxLatitudeRad: number;
    inverseToleranceRad: number;
  };

  cells: {
    scheme: string;
    terrainSubdivisions: number;
    maxNeighborLodDelta: number;
  };

  streaming: {
    physicsRadiusMeters: number;
    visibleRadiusMeters: number;
    retentionRadiusMeters: number;
    predictionSeconds: number;
  };

  lod: {
    refineThresholdPixels: number;
    mergeThresholdPixels: number;
  };

  pipeline: PipelineBudgets;

  frame: {
    fixedStepSeconds: number;
    maxFrameDeltaSeconds: number;
    gpuUploadBudgetMs: number;
  };

  cache: MemoryBudgets;

  procedural: {
    worldSeed: bigint;
    generatorVersion: string;
  };
}
```

Validation au démarrage :

```text
unitsPerMeter = 1
physicsRadius < visibleRadius < retentionRadius
mergeThreshold < refineThreshold
terrainSubdivisions est compatible avec la stratégie de LOD
tous les budgets sont positifs
```

---

## 18. Arborescence recommandée

```text
src/
├── app/
│   ├── bootstrap.ts
│   ├── game-loop.ts
│   ├── world-config.ts
│   └── dependency-container.ts
│
├── geo/
│   ├── units.ts
│   ├── wgs84.ts
│   ├── geodetic.ts
│   ├── ecef.ts
│   ├── enu.ts
│   ├── three-frame.ts
│   ├── vertical-reference.ts
│   ├── geo-anchor.ts
│   ├── mercator.ts
│   ├── cell-scheme.ts
│   ├── mercator-cell-scheme.ts
│   └── floating-origin.ts
│
├── world/
│   ├── world-session.ts
│   ├── world-cell-id.ts
│   ├── world-cell-state.ts
│   ├── world-streamer.ts
│   ├── cell-scheduler.ts
│   ├── cell-pipeline.ts
│   ├── visibility-resolver.ts
│   ├── world-query.ts
│   └── provenance.ts
│
├── providers/
│   ├── provider-registry.ts
│   ├── coverage.ts
│   ├── terrain-provider.ts
│   ├── imagery-provider.ts
│   ├── vector-provider.ts
│   ├── terrain/
│   ├── imagery/
│   └── vectors/
│
├── generation/
│   ├── generation-context.ts
│   ├── stable-hash.ts
│   ├── deterministic-random.ts
│   ├── terrain/
│   │   ├── terrain-sampler.ts
│   │   ├── edge-lattice.ts
│   │   ├── normal-builder.ts
│   │   └── terrain-builder.ts
│   ├── roads/
│   ├── buildings/
│   ├── water/
│   ├── vegetation/
│   └── regional-architecture/
│
├── streaming/
│   ├── task-priority.ts
│   ├── task-queue.ts
│   ├── pipeline-budgets.ts
│   ├── revision-guard.ts
│   └── retry-policy.ts
│
├── cache/
│   ├── memory-lru.ts
│   ├── indexeddb-cache.ts
│   ├── cache-key.ts
│   └── cache-policy.ts
│
├── render/
│   ├── three-renderer.ts
│   ├── scene-roots.ts
│   ├── cell-renderer.ts
│   ├── cell-transform.ts
│   ├── resource-registry.ts
│   ├── material-registry.ts
│   ├── instance-pools.ts
│   └── gpu-upload-queue.ts
│
├── runtime/
│   ├── player/
│   │   ├── player-geo-state.ts
│   │   ├── player-controller.ts
│   │   └── player-view.ts
│   ├── camera/
│   ├── input/
│   └── physics/
│
├── workers/
│   ├── worker-pool.ts
│   ├── worker-protocol.ts
│   ├── terrain.worker.ts
│   ├── vectors.worker.ts
│   └── generation.worker.ts
│
├── debug/
│   ├── debug-overlay.ts
│   ├── geo-debug-view.ts
│   ├── cell-debug-view.ts
│   ├── seam-debug-view.ts
│   ├── provenance-debug-view.ts
│   └── performance-monitor.ts
│
└── shared/
    ├── errors.ts
    ├── result.ts
    ├── logger.ts
    └── assertions.ts

tests/
├── unit/
│   ├── geo/
│   ├── cells/
│   ├── terrain/
│   ├── generation/
│   └── scheduler/
├── integration/
│   ├── provider-alignment/
│   ├── streaming/
│   ├── floating-origin/
│   └── cache/
├── visual/
├── performance/
└── fixtures/

docs/
├── architecture/
│   └── ZERANA_WORLD_ENGINE.md
└── adr/
```

### 18.1 Démarrage progressif

Ne pas créer tous les fichiers vides.

Première tranche :

```text
src/
├── app/
├── geo/
├── render/
├── debug/
└── tests/
```

Puis ajouter le streamer lorsqu’une cellule unique est mathématiquement validée.

---

## 19. Communication entre modules

### 19.1 Injection explicite

Les dépendances sont passées au constructeur ou aux fonctions.

```ts
class WorldStreamer {
  constructor(
    private readonly scheme: WorldCellScheme,
    private readonly providers: ProviderRegistry,
    private readonly workerPool: WorkerPool,
    private readonly cache: WorldCache,
    private readonly renderer: CellRenderPort,
    private readonly config: WorldConfig,
  ) {}
}
```

### 19.2 Événements

Un bus global mémorisant tous les événements est interdit.

Les événements autorisés sont :

- typés ;
- locaux à un domaine ;
- désinscriptibles ;
- non persistants par défaut ;
- observables en debug.

```ts
interface Subscription {
  unsubscribe(): void;
}
```

Les flux critiques préfèrent des appels explicites.

### 19.3 Erreurs

```ts
type WorldErrorCode =
  | 'INVALID_COORDINATE'
  | 'OUTSIDE_PROVIDER_COVERAGE'
  | 'VERTICAL_REFERENCE_UNKNOWN'
  | 'NETWORK_FAILURE'
  | 'DECODE_FAILURE'
  | 'STALE_REVISION'
  | 'MEMORY_BUDGET_EXCEEDED'
  | 'GPU_UPLOAD_FAILURE';
```

Une erreur possède :

- code ;
- message humain ;
- cellule ;
- provider ;
- révision ;
- cause ;
- récupérabilité ;
- fallback appliqué.

---

## 20. Debug et observabilité

### 20.1 Overlay obligatoire

```text
FPS
frame time CPU
frame time GPU si disponible
position lat/lon/alt
position ECEF
origine géographique courante
position locale
cellule courante
LOD courant
SSE courant
cellules visibles
cellules retenues
cellules en erreur
requêtes réseau actives
tâches workers
file upload GPU
mémoire estimée
distance au prochain rebase
erreur maximale de seam
référentiel vertical actif
provenance sous le curseur
```

### 20.2 Modes visuels

```text
F1 : frontières et IDs des cellules
F2 : couleurs par LOD
F3 : grille de samples terrain
F4 : bords et halos
F5 : sources vectorielles brutes
F6 : footprints et propriétaires
F7 : colliders
F8 : axes ENU et ancrages
F9 : provenance réel/dérivé/procédural
F10: mémoire et résidence
```

### 20.3 Métriques

Les métriques importantes sont historisées sur une fenêtre glissante :

- p50/p95/p99 du frame time ;
- latence provider ;
- durée decode/génération/upload ;
- cache hit rate ;
- cells/sec ;
- bytes/sec ;
- nombre d’annulations ;
- résultats obsolètes rejetés ;
- mémoire par catégorie ;
- nombre de ressources Three.js.

---

## 21. Tests obligatoires

### 21.1 Géodésie

Tests avec fixtures indépendantes :

- équateur ;
- méridien de Greenwich ;
- antiméridien ;
- latitudes négatives ;
- altitudes négatives ;
- haute altitude ;
- proximité des pôles ;
- points aléatoires.

Objectifs initiaux :

```text
WGS84 → ECEF : erreur métrique < 1 mm
ECEF → WGS84 : erreur métrique reconstruite < 1 mm
```

### 21.2 Propriétés ENU

Pour plusieurs ancrages :

```text
R Rᵀ ≈ I
det(R) ≈ +1
ENU → ECEF → ENU ≈ identité
```

### 21.3 Échelle

Créer un déplacement local d’un mètre vers l’est, le nord et le haut à :

- l’équateur ;
- Paris ;
- Tanger ;
- Tokyo ;
- latitude élevée.

Attendu :

```text
distance Three ≈ 1 m
```

La taille du joueur reste inchangée.

### 21.4 Mercator

Tester :

- round-trip longitude/latitude ;
- coin de tile ;
- centre de tile ;
- fraction interne ;
- wrap de `x` ;
- bornes de `y` ;
- clamp de latitude ;
- franchissement de l’antiméridien.

### 21.5 Continuité du terrain

Pour chaque paire de voisins :

```text
rightEdge(A) == leftEdge(B)
bottomEdge(A) == topEdge(B)
```

Tester aussi :

- normales de bord ;
- textures ;
- colliders ;
- LOD identique ;
- différence de LOD égale à 1 ;
- ordre de chargement inversé.

### 21.6 Superposition

Fixtures synthétiques :

- raster quadrillé ;
- DEM avec pente connue ;
- route traversant quatre cellules ;
- bâtiment sur une frontière ;
- polygone franchissant l’antiméridien.

Le rendu attendu doit détecter tout décalage supérieur à la tolérance.

### 21.7 Origine flottante

Avant et après rebase :

```text
pose ECEF identique
distance entre objets identique
vitesse identique dans le nouveau repère
caméra sans saut
collider sans saut
cellules à la même position réelle
```

Effectuer plusieurs centaines de rebases successifs.

### 21.8 Déterminisme

Vérifier :

- identité stable ;
- seed stable ;
- résultat indépendant de l’ordre de chargement ;
- résultat indépendant de la présence des voisins ;
- tri stable ;
- version de générateur dans les clés.

### 21.9 Streaming longue durée

Simuler plusieurs milliers de changements de cellule.

Attendus :

- mémoire atteignant un plateau ;
- aucune croissance de listeners ;
- aucune cellule dupliquée ;
- aucun collider orphelin ;
- aucune ressource GPU orpheline ;
- résultats obsolètes rejetés ;
- cache respectant son budget ;
- aucune disparition du terrain sous le joueur.

### 21.10 Performance

Benchmarks séparés :

- conversion géodétique ;
- génération terrain ;
- sampling DEM ;
- clipping ;
- triangulation ;
- génération bâtiments ;
- upload GPU ;
- disposal ;
- rebase.

Les régressions de performance doivent être visibles dans la CI.

### 21.11 Tests visuels

Captures déterministes de scènes de référence :

- cellule unique ;
- grille 3×3 ;
- bord de LOD ;
- pente ;
- bâtiment frontalier ;
- origine avant/après rebase ;
- fallback procédural.

---

## 22. Objectifs de performance

### 22.1 Cible

Cible principale :

```text
60 FPS
budget total ≈ 16,67 ms/frame
```

Le moteur doit également rester jouable à 30 FPS sur une configuration moins favorable grâce à la qualité adaptative.

### 22.2 Budget indicatif du thread principal

```text
input + simulation       : faible et stable
streaming scheduler      : sous-budget borné
mises à jour transforms  : proportionnelles au visible
uploads GPU              : budget explicite
render                   : reste de la frame
```

Règle pratique :

> aucune tâche non interruptible du thread principal ne devrait provoquer seule une longue frame.

### 22.3 Critères d’acceptation de fluidité

Lors d’une marche continue :

- pas de freeze lors d’une entrée de cellule ;
- pas de trou devant le joueur ;
- pas de changement d’échelle ;
- pas de saut d’altitude ;
- pas de croissance mémoire continue ;
- pas de burst massif d’uploads ;
- pas de rechargement immédiat d’une cellule juste évincée ;
- dégradation progressive en cas de réseau lent.

---

## 23. Fournisseurs, secrets et licences

### 23.1 Abstraction fournisseur

Aucun fournisseur ne doit être codé en dur dans le domaine.

```ts
interface ProviderRegistry {
  terrain(id: string): TerrainProvider;
  imagery(id: string): ImageryProvider;
  vectors(id: string): VectorProvider;
}
```

### 23.2 Credentials

- les tokens publics à portée restreinte peuvent être fournis par configuration ;
- les secrets privés ne doivent jamais être inclus dans le bundle ;
- les clés exposées dans l’historique doivent être révoquées ;
- un backend proxy est utilisé lorsqu’un secret ou une politique l’exige ;
- aucune clé n’est écrite dans une constante versionnée.

### 23.3 Licences et attribution

Chaque provider doit déclarer :

- licence ;
- attribution ;
- droit de cache ;
- durée de conservation ;
- droit de dérivation ;
- couverture ;
- limites de requêtes.

Le cache respecte ces règles. Une donnée interdite de persistance ne doit pas être conservée dans IndexedDB.

---

## 24. Migration depuis Zerana V1

### 24.1 À conserver comme idées

- Three.js ;
- streaming autour du joueur ;
- Web Workers ;
- récupération du relief ;
- limitation de concurrence ;
- génération procédurale ;
- avatars ;
- chargement prioritaire des zones proches ;
- intention d’utiliser des données OSM et un backend ;
- recyclage des ressources ;
- debug visuel des cellules.

### 24.2 À remplacer

- `GlobeManager` monolithique ;
- coexistence `GlobeManager` / `ChunkManager` ;
- `stubPlayer` ;
- `CHUNK_SIZE` comme échelle universelle ;
- redimensionnement du joueur ;
- lien direct `une tile = un chunk` ;
- conversions locales dispersées ;
- définition incohérente des frontières de chunks ;
- traitement RGB avant décodage ;
- EventBus global persistant ;
- création de ressources Three.js dans plusieurs domaines ;
- erreurs asynchrones silencieuses ;
- gestion partielle du disposal.

### 24.3 Stratégie Git

Recommandation :

```text
main
  └── état stable de Zerana V2

legacy/v1
  └── archive de l’ancien prototype

feature/v2-geo-kernel
feature/v2-single-cell
feature/v2-streaming
...
```

Ne pas réécrire l’historique utile du prototype.

### 24.4 Réutilisation du code

Le code V1 ne doit être copié dans V2 que si :

- sa responsabilité est claire ;
- ses dépendances respectent la nouvelle architecture ;
- il possède des tests ;
- ses unités sont explicites ;
- ses erreurs sont gérées ;
- sa mémoire est libérée ;
- sa formule a été vérifiée.

Sinon, conserver uniquement l’idée.

---

## 25. Roadmap normative

### Milestone 0 — Référence et garde-fous

Livrables :

- ce document versionné ;
- dossier `docs/adr/` ;
- TypeScript strict ;
- lint, format et tests ;
- CI minimale ;
- convention d’unités.

Definition of Done :

- aucune règle fondamentale n’est ambiguë ;
- tout changement majeur passe par ADR.

### Milestone 1 — Geo Kernel

Implémenter :

- unités ;
- WGS84 ;
- géodétique ↔ ECEF ;
- ECEF ↔ ENU ;
- mapping Three ;
- Mercator ;
- `GeoAnchor` ;
- origine flottante mathématique.

Definition of Done :

- fixtures indépendantes ;
- tests de propriété ;
- tolérances respectées ;
- aucune dépendance Three.js dans `geo/`.

### Milestone 2 — Une cellule terrain

Afficher une cellule avec :

- limites exactes ;
- relief ;
- texture ;
- axes ;
- ancrage ;
- grille de samples ;
- collider de debug.

Definition of Done :

- une adresse apparaît à sa position interne exacte ;
- `1 unité = 1 mètre` ;
- texture et relief alignés.

### Milestone 3 — Grille de cellules

Afficher 4 puis 9 cellules.

Definition of Done :

- bords communs ;
- normales communes ;
- aucun trou ;
- ordre de chargement sans effet ;
- mémoire libérée après retrait.

### Milestone 4 — Joueur et origine flottante

Ajouter :

- source de vérité ECEF ;
- mouvement à pas fixe ;
- caméra ;
- collider ;
- rebases successifs.

Definition of Done :

- aucune variation de taille ;
- aucune téléportation visuelle ;
- altitude stable ;
- rebases testés automatiquement.

### Milestone 5 — Streaming et cache

Ajouter :

- scheduler ;
- rayons en mètres ;
- prédiction ;
- annulation ;
- révisions ;
- workers ;
- upload GPU budgété ;
- LRU ;
- IndexedDB ;
- fallback terrain.

Definition of Done :

- marche continue longue durée ;
- pas de trou sous le joueur ;
- mémoire en plateau ;
- réseau lent simulé.

### Milestone 6 — Routes, eau et landcover

Definition of Done :

- clipping correct ;
- objets traversant les cellules ;
- alignement terrain ;
- provenance visible ;
- antimeridien testé sur fixture.

### Milestone 7 — Bâtiments simples

Ajouter :

- footprints ;
- hauteur ;
- fondation ;
- toiture simple ;
- ownership stable ;
- collider proche.

Definition of Done :

- aucun doublon frontalier ;
- base cohérente avec le terrain ;
- LOD simple ;
- disposal complet.

### Milestone 8 — Génération régionale

Ajouter :

- contexte régional ;
- façades ;
- matériaux ;
- toits ;
- végétation ;
- mobilier ;
- seed versionné.

Definition of Done :

- monde stable d’une session à l’autre ;
- distinction réel/estimé/procédural ;
- densité et performances mesurées.

### Milestone 9 — LOD et optimisation avancés

Ajouter :

- SSE ;
- quadtree ;
- transitions ;
- stitching ;
- instancing ;
- batching ;
- qualité adaptative ;
- occlusion optionnelle.

Definition of Done :

- seuils sans oscillation ;
- transitions sans trou ;
- objectifs de fluidité atteints sur machines de test.

---

## 26. Règles de développement

### 26.1 Pull requests

Chaque PR doit :

- avoir une responsabilité principale ;
- inclure ou mettre à jour les tests ;
- documenter les unités ;
- documenter les erreurs ;
- indiquer l’impact mémoire ;
- indiquer l’impact thread principal ;
- mettre à jour un ADR si nécessaire ;
- ne pas mélanger refactor massif et feature critique.

### 26.2 Formules

Toute formule critique doit être accompagnée de :

- définition de chaque variable ;
- unité ;
- domaine de validité ;
- cas limites ;
- référence ou dérivation ;
- test ;
- tolérance.

### 26.3 Nommage

Exemples corrects :

```ts
latitudeRad
heightMeters
velocityMetersPerSecond
fixedStepSeconds
gpuUploadBudgetMs
```

Exemples interdits :

```ts
lat
height
speed
scaleFactor
size
```

lorsque l’unité ou le sens n’est pas évident.

### 26.4 Assertions

En développement :

```ts
assertFinite(position.xMeters);
assertRadians(latitudeRad);
assertPositive(config.visibleRadiusMeters);
assert(config.mergeThresholdPixels < config.refineThresholdPixels);
```

Les assertions de domaine mathématique sont conservées dans les tests et peuvent être adaptées en production.

### 26.5 Pas de correction visuelle magique

Interdits sans explication :

- `+ 0.5` pour réaligner un chunk ;
- `* cos(latitude)` appliqué au joueur ;
- offset de texture empirique ;
- altitude globale arbitraire ;
- duplication d’un bord pour masquer une erreur ;
- changement de scale selon le lieu.

Toute correction doit être expliquée par le modèle mathématique.

---

## 27. Definition of Done globale

Une fonctionnalité mondiale n’est terminée que si :

- [ ] ses unités sont explicites ;
- [ ] sa position globale est traçable ;
- [ ] son référentiel vertical est connu ;
- [ ] elle fonctionne au changement de cellule ;
- [ ] elle fonctionne après rebase ;
- [ ] elle fonctionne à l’antiméridien si concernée ;
- [ ] elle respecte le budget mémoire ;
- [ ] ses tâches sont annulables ;
- [ ] ses résultats portent une révision ;
- [ ] ses ressources sont libérées ;
- [ ] elle possède des tests ;
- [ ] son mode debug existe ;
- [ ] son fallback est défini ;
- [ ] sa provenance est disponible ;
- [ ] son comportement LOD est défini ;
- [ ] elle ne redimensionne pas le joueur.

---

## 28. ADR à créer

Les décisions suivantes doivent être suivies dans `docs/adr/` :

```text
ADR-001 — 1 unité Three.js = 1 mètre
ADR-002 — WGS84/ECEF comme vérité globale
ADR-003 — Repère local ENU et axes Three
ADR-004 — Origine flottante
ADR-005 — Séparation WorldCell / provider tile
ADR-006 — Schéma Web Mercator initial
ADR-007 — Référentiel vertical canonique
ADR-008 — Edge lattice du terrain
ADR-009 — Déterminisme procédural
ADR-010 — Pipeline worker et paquets transférables
ADR-011 — Stratégie LOD/SSE
ADR-012 — Propriété et disposal des ressources Three.js
ADR-013 — Cache et contraintes de licence
ADR-014 — Source de vérité unique du joueur
```

---

## 29. Risques principaux

| Risque | Mitigation |
|---|---|
| Décalage horizontal entre sources | Transformation canonique unique + fixtures synthétiques |
| Décalage vertical | Métadonnées de datum + conversion explicite |
| Fissures terrain | Edge lattice partagé + halo + tests |
| Flottement à grande distance | ECEF Float64 + ENU + origine flottante |
| Trous réseau | parent/fallback conservé + chargement progressif |
| Freeze lors d’un chargement | workers + backpressure + upload budgété |
| Fuite mémoire | Resource Registry + tests longue durée |
| Doublons aux frontières | ownership stable + clipping déterministe |
| Monde procédural instable | seed/version/tri explicites |
| Dépendance fournisseur | interfaces + registry + fallback |
| Coût ou limites d’API | cache conforme + backend optionnel |
| Surarchitecture | milestones verticaux, pas de fichiers vides |
| Pôles Mercator | abstraction de schéma + solution cube-sphere future |

---

## 30. Décisions encore ouvertes

Ces choix ne bloquent pas le Geo Kernel :

- fournisseur de DEM initial ;
- fournisseur d’imagerie initial ;
- source vectorielle principale ;
- bibliothèque de triangulation ;
- moteur de physique ;
- format du cache de mesh ;
- backend de prétraitement ;
- modèle de géoïde ;
- stratégie exacte de cube-sphere ;
- algorithme de simplification des bâtiments ;
- technique de geomorphing terrain ;
- pipeline de façades ;
- format de sauvegarde du joueur.

Chaque choix doit respecter les interfaces et invariants du présent document.

---

## 31. Première tranche de travail concrète

La première branche V2 doit contenir uniquement :

```text
src/geo/units.ts
src/geo/wgs84.ts
src/geo/geodetic.ts
src/geo/ecef.ts
src/geo/enu.ts
src/geo/three-frame.ts
src/geo/geo-anchor.ts
src/geo/mercator.ts
src/geo/mercator-cell-scheme.ts
src/geo/floating-origin.ts

tests/unit/geo/
docs/adr/ADR-001-*.md
docs/adr/ADR-002-*.md
docs/adr/ADR-003-*.md
docs/adr/ADR-004-*.md
```

Le rendu initial peut se limiter à :

- un repère d’axes ;
- une grille métrique ;
- une sphère joueur de debug ;
- quatre coins de cellule ;
- l’affichage des coordonnées.

Aucun bâtiment, avatar final, végétation ou façade ne doit être ajouté avant validation du noyau.

---

## 32. Résumé exécutable

```text
1. La Terre est décrite en WGS84/ECEF Float64.
2. Le joueur possède une seule position globale.
3. Le rendu travaille en ENU local proche de zéro.
4. Three.js utilise X Est, Y Haut, Z Sud.
5. Une unité vaut un mètre.
6. Le joueur ne change jamais de scale.
7. Une WorldCell n’est pas une tile fournisseur.
8. Toutes les sources sont reprojetées dans le même référentiel.
9. Le terrain partage ses samples de bord.
10. Les hauteurs déclarent leur datum.
11. Les generators sont purs, seedés et versionnés.
12. Le streaming utilise des rayons en mètres et des révisions.
13. Les parents restent visibles pendant le chargement des enfants.
14. Les traitements lourds vont dans les workers.
15. Les uploads GPU sont budgétés.
16. Le rendu possède et libère toutes les ressources Three.js.
17. Les performances, seams et rebases sont mesurés.
18. Les maths sont validées avant le contenu.
```

---

## 33. Décision finale

Zerana V2 repart sur un nouveau moteur mondial, mais conserve les apprentissages du prototype.

Le projet ne doit plus compenser les erreurs de projection par des changements de scale visuels. Il doit représenter correctement les coordonnées, les distances, les altitudes et les frontières.

La priorité absolue est donc :

> **Construire un Geo Kernel petit, indépendant, documenté et testé, puis brancher progressivement Three.js, le terrain et le streaming autour de lui.**

Tant que le moteur ne démontre pas qu’un mètre reste un mètre, qu’un point reste au même endroit après rebase et que deux cellules partagent exactement leur bord, aucune complexité visuelle ne doit être considérée comme prioritaire.
