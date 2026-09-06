# Étape 14 — Environmental Vector Kernel

Base : `02199177a9364eb9dabaff16532fc36f398aee4d`. Périmètre : données et diagnostic
**automatiques**, pas des surfaces d'eau, de la végétation ou un solveur hydraulique.

## Parcours

`/Zerana/v2/?source=mapbox&level=19&environment=1` affiche le diagnostic.
`source=synthetic` évite les appels payants. La case « Afficher les contours
environnementaux » est dans les outils du laboratoire ; elle ne lance aucun
chargement. Les données suivent les **surfaces routières automatiques**. Quand
cette couche routière est désactivée, aucun nouveau travail environnemental n'est
demandé. Le diagnostic peut rester masqué : dans ce cas ses nouveaux buffers ne
sont pas envoyés au GPU. Aucun nouveau bouton d'analyse obligatoire.

Bleu : polygones d'eau et axes de cours d'eau. Vert : couvert végétal.
Violet : zones humides. Rose : usages du sol. Les lignes suivent les triangles
existants uniquement pour contrôler l'alignement : **ce ne sont ni les altitudes
physiques de l'eau, ni une preuve que les cours d'eau suivent le relief**.

## Une acquisition, plusieurs consommateurs

Le worker routier existant conserve un `VectorTileSnapshot` contenant routes,
`water`, `waterway`, `landuse`, `landuse_overlay`. Chaque MVT est téléchargée une
fois tant qu'elle est en cache ; un unique parseur protobuf alimente les
adaptateurs. Géométrie canonique environnementale préparée une fois par tuile,
puis partagée entre WorldCells. Aucun second streamer, pool, quota réseau ou
cache persistant. Une éviction du cache source peut nécessiter un nouveau fetch.

Le zoom source reste `min(niveauCellule, TileJSON.maxzoom)` : Z16 avec les
métadonnées actuelles, sans prétendre qu'overzoomer améliore la donnée. L19 est
le réglage conseillé pour ce diagnostic, pas une nouvelle échelle du joueur.
Chaque couche utilise son propre `extent`, y compris dans une même MVT.

## Géométrie et sens des données

- Coordonnées source : `(tileX × extent + localX) / (extent × 2^z)` et même
  formule pour Y. Fractions BigInt réduites ; aucun arrondi de raccord ajouté.
- MVT Y vers le bas : extérieur d'aire orientée positive, trous négatifs qui
  suivent leur extérieur. Plusieurs extérieurs restent plusieurs polygones.
- Une portion de WorldCell est représentée par **P ∩ rectangle**, avec les
  anneaux originaux et un domaine exact de clipping. Cette forme implicite
  préserve trous et composantes disjointes ; ce n'est pas une liste d'anneaux
  déjà découpés/triangulés. Une prochaine triangulation devra respecter ce contrat.
- Seuls les segments source sont découpés pour le diagnostic. Les coupures de
  cellule ne créent pas de nouvelles rives. Les arêtes exactement sur le cœur
  d'une tuile source sont masquées comme limites ambiguës, pas certifiées rives.
- Propriété demi-ouverte : **Ouest et nord inclus, est et sud exclus**,
  sauf l'extrême sud sans voisin. Une frontière de trou exclut le couvert.
- Les polygones sont issus d'une source cartographique : contrôles de commandes,
  fermeture, taille, winding et coordonnées ; pas une réparation générale des
  auto-intersections ou une certification topologique du fournisseur.
- `environmentAt` conserve toutes les classifications superposées, dans un
  ordre stable. Pas de règle implicite « dernier arrivé gagnant », de confiance
  chiffrée inventée ni de forêt déduite d'un simple parc.
- Couvert, usage et zone humide sont séparés. Un polygone `water` reste
  `WATER_AREA`, sans inventer lac/mer, sens d'écoulement, niveau ou HydroID.
  Les IDs internes désignent un élément du snapshot, pas un objet mondial stable.
- Couches absentes, classes inconnues et données invalides restent distinguées.
  Révisions de tuiles contradictoires entre diagnostics résidents sont refusées.

## Streaming et budgets

Les résultats secondaires s'attachent au même objet terrain et à sa révision.
Annulation/changement de monde invalide les réponses tardives. Les racines des
cellules gèrent visibilité et rebase ; le recyclage conserve les mêmes buffers
et UUID. L'éviction détruit les ressources Three correspondantes sans toucher
aux colliders ni modifier le terrain. Aucun matériau satellite n'est remplacé.

Limites environnementales : 4 096 features et 65 536 points par tuile ; 8 192
paths ; 131 072 points de contexte utile par cellule ; 12 000 segments de
rendu ; paquet ≤1 Mio, diagnostics résidents ≤4 Mio, comptés dans le recyclage.
LRU vectoriel partagé inchangé : 16 Mio / 16 snapshots ; batch ≤32 Mio. Sous
pression, les vues environnementales peuvent être refusées sans invalider des
routes valides. Les compteurs sont des budgets de payload/estimations, pas une
mesure exhaustive du heap ou de la VRAM. Travail GPU non préemptible.

## Validation et limites

Tests CPU : îles/trous, plusieurs extérieurs, forme concave coupée en morceaux,
cellule entièrement couverte, frontières, classification multiple, extent mixte,
antiméridien, révisions, budget et raccord ECEF <1 mm. Ce seuil porte sur le
raccord calculé, **pas** sur l'exactitude géographique des données Mapbox.
Tests binaires : MVT multisouche, commandes malformées, réutilisation des tuiles,
aucun second décodage au retour en cache, isolation des erreurs environnementales.
Tests navigateur : streaming sans analyse, marche/retour, rebase, masquage,
quota partagé et invalidation. Live optionnel borné : Seine + Tuileries, L19,
128 tentatives maximum au total ; pas de token ou MVT brut dans les preuves.

Le mode de terrassement expérimental `engineering=1` n'affiche pas ce diagnostic
pour l'instant. Son précédent test réel `34029167111` a **échoué** à Paris ;
la PR14 ne le présente pas comme validé et ne modifie pas son solveur. Le mode
routier normal avait passé le test réel. Les résultats finaux de cette PR sont
consignés dans sa discussion après CI et contrôle du déploiement.

À suivre : PR15 niveaux/surfaces d'eau résolus hors des cellules ; PR16 champ
sémantique compact et exclusions ; pas de glissement silencieux de périmètre.

## Sources primaires consultées le 6 septembre 2026

- Mapbox Streets v8 : couches, classifications, IDs fusionnés et absence de
  distinction des plans d'eau : https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/
- MVT 2.1 : commandes, grille, winding, extérieurs et trous :
  https://github.com/mapbox/vector-tile-spec/blob/master/2.1/README.md
- Code Zerana V2 au commit de base : road-source, road.worker, surface-layer,
  recyclage, surface-query issue du drapage routier existant et Geo Kernel.
