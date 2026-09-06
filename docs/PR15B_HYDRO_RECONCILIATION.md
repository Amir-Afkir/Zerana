# PR15b — Hydro / Terrain Reconciliation

Base auditée : `fc64a696fe1854e4fe563e07bf7de08592dcd1ea` (PR15).
Statut : correction sur branche isolée, aucune qualification de livraison avant
CI et régression Seine réelle. Mode de revue : `?source=mapbox&level=19&hydro=1`.
Le mode PR15 historique est conservé pour les régressions comparatives ; ce
paramètre n'est pas présenté comme un déploiement par défaut.

## Diagnostic vérifié

PR15 construit le terrain brut et son collider avant de demander l'eau. Son
champ d'eau filtré et le DEM brut sont différents. Le décalage visuel de 3 cm
ne peut pas corriger une intersection géométrique. Son test réel précédent a
échoué ; la présence de pixels d'eau n'est pas une preuve d'absence de conflits.

## Chaîne mise en place

```
RawElevationSource + snapshots vectoriels avec empreintes
  → HydroRegion géographique fixe + WaterSurfaceProfile
  → HydroConditionedElevationSource (vue dérivée, avant maillage)
  → grille mondiale partagée → terrain + BVH du même terrain
  → eau issue du même profil, sans offset vertical
  → certificat des intersections des triangles réellement envoyés au GPU
  → cohorte versionnée → admission cachée → physique et visibilité
```

Le Geo Kernel, la V1 et les dépendances restent inchangés. Positions globales
WGS84/ECEF Float64, GPU local ENU/Est-Haut-Sud Float32, mètres partout. Les
WorldCells L19/L21 ne sont pas assimilées aux tuiles de données. Le mode conserve
32 subdivisions et refuse les résolutions grossières avant tout appel réseau.

## Modules

- `generation/hydro/conditioned-elevation.ts` : source dérivée, politique et rive.
- `generation/hydro/profiles.ts` : profils partagés, classification et niveaux.
- `generation/hydro/certificate.ts` : preuve sur intersections triangulaires.
- `generation/hydro/crossings.ts` : strates et croisements ambigus différés.
- `demo/hydro/source.mjs` : orchestration des sources dans le worker existant.
- `demo/hydro/cohort.mjs` : validation, révisions et budgets avant admission.
- Worker terrain, bootstrap et `CellAdmission` : cohortes préparées ensemble.
- `WaterSurfaceView` réemploie strictement le shader PR15 ; pas de camouflage.

## Sources et révisions

Le DEM brut n'est jamais réécrit. La source dérivée conserve son datum et déclare
`preview-artificial-hydro-clearance`. Les clés de région sont fixes à Z16 ; les
métadonnées TileJSON doivent permettre ce niveau, sinon le contrat refuse.
Le contexte vectoriel 3×3 est acquis une fois via RoadSource et utilisé par
terrain, eau, routes et diagnostic. Le cache PNG existant du worker sert au DEM.

La révision SHA-256 lie politique, région et readset DEM/vectoriel trié. Les
readsets sont comparés à toutes les cohortes résidentes avant admission et de
nouveau avant l'installation physique. Un changement de token détruit les
caches associés. Aucune persistance IndexedDB/artefact de données Mapbox brutes.
Une éviction suivie d'une réacquisition incompatible ne modifie pas le monde
sous le joueur : nouvelle cohorte refusée, ancien sol conservé.

## Profils et qualification

- **CLOSED_STANDING_WATER** : empreinte entièrement fermée dans le contexte
  qualifiable, sans axe voisin ; médiane d'échantillons des berges originales
  espacés de 8 m au plus, pas une médiane du fond intérieur. Même niveau pour
  toutes les cellules de ce plan. Un grand lac coupé par la source n'est pas
  arbitrairement certifié fermé.
- **FLOWING_WATER / LINEAR_WATERWAY** : filtre du DEM sur grille mondiale fixe,
  projection sur les axes proches disponibles. La variation est continue C0
  sur les triangles du champ partagé ; ce n'est **pas** un solveur de corridor
  mondial C1, ni une garantie de sens d'écoulement. Les confluences/écluses et
  les grands plans partiellement connus restent non qualifiés hydrauliquement.
- **COASTAL_OPEN_WATER** : champ local estimé, jamais `seaLevel=0 WGS84`.
- **UNRESOLVED** : pas de contrainte physique inventée. Les cours intermittents
  ou inconnus que PR15 différerait ne deviennent pas des eaux permanentes.

La confiance est qualitative : `estimated-not-hydraulically-qualified`, datum
`UNRESOLVED_DATUM_PREVIEW` pour Mapbox. L19 n'améliore pas la précision source.

## Conditionnement métrique

Pour un point occupé par l'eau et hors île :

```
H_target = min(H_raw, H_water - clearance)
H_final  = H_target
```

Clearance artificielle : 0,50 m pour plans/flux ouverts ou fermés, 0,25 m pour
petits cours linéaires. Ce sont des **valeurs de jeu versionnées**, ni profondeur
mesurée, ni bathymétrie. Un fond naturel déjà plus bas reste inchangé.
Abaissement autorisé au plus 12 m ; au-delà, refus explicite, pas d'augmentation
automatique. L'eau n'est pas remontée pour satisfaire le contrôle.

Sur terre proche d'une rive externe : plateau conservateur de support de grille
4 m, puis raccord de 6 m. Distances en mètres par les facteurs ellipsoïdaux :

```
S(t)=6t^5-15t^4+10t^3, t clampé dans [0,1]
alpha=1-S((distanceRive-4m)/6m)
H_final=H_raw+alpha(min(H_raw,H_water-clearance)-H_raw)
```

Au-delà de 10 m, identité avec le brut. Le support fixe de 4 m couvre la
 diagonale de grille L19/32 à l'équateur (moins de 3,4 m) ; il ne suit jamais
le joueur. Une frontière artificielle de tuile n'est pas une berge. Les trous
explicites sont exclus de toute déformation, y compris du falloff.

### Limite importante des îles et breaklines

Une grille non conforme à la rive peut interpoler au-dessus de l'eau à proximité
d'une île haute, même si tous les échantillons dans l'eau sont abaissés. Le
certificat final interdit l'admission d'une telle cohorte. Il ne creuse pas les
échantillons d'île pour faire passer le test et ne retire pas silencieusement les
triangles d'eau en conflit. Cela signifie qu'un cas sous-résolu peut **rester
bloqué explicitement** en attente de breaklines/refinement, plutôt qu'être
présenté comme corrigé. Le maintien exact de toute la surface triangulée d'une
petite île entre échantillons n'est pas une propriété établie par le masque seul.
Les contours canoniques et les trous restent disponibles pour cette étape.

## Certificat et admission

Le certificat travaille sur les triangles Float32 effectivement rendus, dans
le même repère local. On intersecte chaque triangle d'eau avec les triangles
terrain candidats via une grille de recherche bornée. Sur chaque intersection
convexe, `H_terrain-H_water` est affine : son maximum est atteint à un sommet
de l'intersection. Tous ces sommets sont contrôlés, pas seulement les vertices
initiaux ou des rayons aléatoires.

`maxTerrainAboveWaterMeters <= 0,00001 m` (10 µm de tolérance numérique).
Le recouvrement projeté est aussi contrôlé : seules les bandes numériques de
bord correspondant à 1 mm de projection sont tolérées, pas un support manquant
à l'intérieur. Une aire ou un triangle dégénéré non résolu provoque un refus.
Ce test n'est pas une certification de l'exactitude des données Mapbox.

TerrainSourceId, HydroRevision et WaterRevision correspondent ; les buffers
physiques proviennent exactement des positions/indices terrain. Le BVH est
construit en worker puis adopté avec validation. Aucune mutation tardive des
vertices ; aucune ancienne eau sur nouveau collider ou inversement. Les étapes
GPU restent cachées avant le commit ; elles ne sont pas préemptibles.

## Routes

Pont/tunnel connus restent dans leurs strates différées existantes. Le
conditionnement peut s'appliquer au terrain nu sous un pont, jamais à un tablier
indépendant. Une ligne routière au sol entrant dans l'eau devient une structure
ambiguë `STRUCTURE_REQUIRED`, exclue du générateur de chaussée au sol. Aucun
pont, tunnel ou gué artificiel n'est construit par cette PR.

## Budgets conservés

- Cohorte complète terrain/BVH/routes/eau/diagnostic : **1 Mio** ; queue CPU
  **4 Mio**, recyclage commun **32 Mio**, sans relever ces seuils.
- Eau : **1 Mio/paquet**, **4 Mio résidents**, 16 000 vertices /20 000 triangles.
- Routes : **2 Mio/paquet**, **8 Mio résidents** ; environnement **4 Mio**.
- HydroRegions : **4 entrées /16 Mio**, incluant estimations géométrie/profils/DEM.
- MVT partagé : **16 entrées /16 Mio**, PNG worker existant **16 Mio**.
- 150 000 intersections candidates pour la preuve ; limites explicites sur
  points, échantillons et nœuds du profil. Aucun plafond relevé pour une fixture.
- Quota de préparation/streaming cohérent : **256 tentatives**, départ compris,
  grants au plus128 par job. Il ne plafonne pas la facturation totale du compte.

Ces compteurs de payload/estimations ne constituent pas une mesure exhaustive
du heap ou de la VRAM. Demi-tour chaud : mêmes buffers et géométries, pas de
requête supplémentaire pour les cellules conservées.

## Diagnostics

`__ZERANA_HYDRO_DEBUG__` expose régions, types, readsets complets, révisions,
clearance, maximum terrain/eau, nombre de samples modifiés, structures différées
et adoption de collider. Un panneau HYDRO les résume dans le laboratoire.
`environment=1` affiche les contours source déjà disponibles ; le bouton eau
compare eau visible/masquée sans changer la physique. Les hauteurs brutes sont
conservées **en mémoire seulement** pour comparaison, jamais dans les rapports.
Un affichage complet des breaklines/falloff en maillage reste à ajouter ; ne pas
confondre ce panneau avec un nouvel éditeur hydrographique.

## Validation de revue

Tests CPU : bosse, lac partagé, slope, rive, îles/trous, point global identique,
raccords <1 mm, ordre/cache, datum/révisions, strates, refus budgétaire et contre-
exemple où les vertices d'eau sont sûrs mais un pic terrain intérieur la traverse.
Tests adaptateurs : génération avant BVH, readsets, cache, quota, abort,
credentials et mêmes buffers terrain/collider. Tous les tests historiques restent.

Navigateur : fixture puis Mapbox réel sur branche **sans déploiement**, via
workflow dédié explicite. Seine PR15 conservée (2.351,48.854), 70 m aller/retour,
trois rebases, mêmes UUID, visibilité par comparaison de pixels, preuve finale
et source physique cohérente. Sondes fixes suivantes : Daumesnil, canal, côte.
Le point canal historique peut ne pas contenir d'eau dans sa fenêtre L19 : ce
cas est rapporté `NO_WATER_IN_REQUESTED_WINDOW`, jamais compté comme eau validée.
La localisation exacte des captures utilisateur n'est pas déductible de leur
barre d'adresse ; les captures restent la référence visuelle, pas des coordonnées
inventées. Le test réel partage un plafond **256 appels au total**.

Une PR préparée n'est pas une livraison. Aucune fusion automatique avant CI et
Seine réelle vertes ; les cas non validés et les limites restent dans le bilan.

## Sources

- Référence normative : `docs/architecture/ZERANA_WORLD_ENGINE.md`.
- PR14/PR15 : `docs/REFONTE_STAGE14.md`, `docs/REFONTE_STAGE15.md`.
- Mapbox Terrain-RGB : datums multiples et couverture :
  https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
- USGS Lidar Base Specification, hydro-flattening : distinction surfaces
  cartographiques planes et profil des rivières ; inspiration, aucune conformité
  revendiquée : https://www.usgs.gov/ngp-standards-and-specifications/lidar-base-specification-appendix-2-hydro-flattening-reference
