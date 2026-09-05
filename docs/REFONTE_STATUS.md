# État de la refonte Zerana V2

Ce document décrit le code présent. Pour identifier la version effectivement publiée,
consulter le manifeste servi par Pages et le dernier workflow de déploiement réussi.
Une PR ouverte ou une compilation réussie ne prouve pas une publication fonctionnelle.

## Baselines et protection

- Prototype V1 : `0e06c350b6c3d07699600e0003609790d60661c4`, branche `legacy/v1`.
- Première préversion V2 publiée : `07ac40b699d2f200e1dd21b3f4900c9d0be827fd`.
- Joueur V2 publié avant streaming : `f567ee65ce5db8a68743823acbf2472e4cd3f99e`.
- Jeu historique : `/Zerana/` ; laboratoire indépendant : `/Zerana/v2/`.
- Les sources V1, assets historiques et lockfiles ne sont pas modifiés par les étapes 5–7.
- Le build combiné compare les sources V1 à la baseline et conserve les empreintes
  des fichiers V1 lors de l'ajout du laboratoire.
- La copie locale du Mac n'est pas modifiée par ces interventions.
- Référence fournie : `ZERANA_ARCHITECTURE_REFERENCE(1).md`, version 1.0.0.
- SHA-256 de cette référence : `8fa7d13540eef938c423a83fc6e207743e48e9c9c9c33432eb10979979ce56f8`.
- Copie normative inchangée : `architecture/ZERANA_WORLD_ENGINE.md`.

## Fonctionnalités implémentées

### Étape 1 — noyau géospatial, PR #1

Unités typées, WGS84, ECEF/ENU, axes Three Est/Haut/Sud, transformations rigides
et cellules Mercator. 80 tests, dont fixtures indépendantes PROJ et changements
successifs de repère. Le noyau ne dépend ni du navigateur ni de Three.js.

### Étape 2 — terrain synthétique, PR #2

Source ellipsoïdale synthétique, grille dyadique canonique, samples et normales avec
halo, paquets CPU et patches 1/4/9 cellules. Les 59 tests terrain ajoutés couvrent
notamment raccords, UV, winding, indices Uint32, cache, antiméridien et rebases.
Voir ADR-002 pour le domaine de précision testé ; aucun résultat échantillonné
n'est présenté comme une borne globale ou une mesure GPU matérielle.

### Étape 3 — relief raster et imagerie, PR #3

Terrain-RGB décodé avant interpolation, centres de pixels, voisins inter-tuiles,
budgets, nodata et textures géoréférencées. 32 tests raster ajoutés. Le provider
Mapbox possède annulation, timeout, retry borné, attribution et provenance.
Le datum vertical mixte Mapbox reste `UNRESOLVED_DATUM_PREVIEW`, pas du WGS84 certifié.

### Étape 4 — préversion publique isolée, PR #4

Les PR #1–#4 sont intégrées. Build composé V1/V2, SHA servi et contrôles HTTP/navigateur.
Neuf tests de livraison ajoutés. Le workflow `33978882824` a validé le déploiement
initial et un seul patch Mapbox réel de neuf cellules : 31 tentatives HTTP, aucun
échec HTTP ou exception JavaScript observé dans ce scénario. Le compte rendu et
les limites sont consignés dans la PR #4, commentaire `5553308822`.
Cela ne certifie ni l'altitude absolue, ni la couverture mondiale, ni les performances.

### Étape 5 — joueur métrique, PR #5 / Milestone 4 de la référence

Joueur ECEF unique, capsule 1,80 m à échelle constante, marche/course, saut, caméra
avec collision, simulation fixe 60 Hz et interpolation. Colliders triangle/BVH
indépendants des buffers visuels, balayage continu borné, glissement et pentes.
Origine flottante appliquée aux poses et aux transformations des colliders, sans
reconstruire leurs sommets. Pause sur blur/onglet caché, réapparition et nettoyage.

La marche reste limitée au terrain déjà chargé ; neuf sondes protègent le bord du
patch. Ce garde-fou n'est pas une preuve de couverture de polygones arbitraires.
La marche Mapbox exige l'opt-in existant et reste expérimentale, `preview-only`.
La construction des colliders utilise encore la résolution du mesh installé.

La CI de l'étape 5 a validé 213 tests cumulés sur Node 22/24, dont 33 tests joueur.
Le déploiement `33982200996` a validé dix scénarios joueur sur la version publiée,
sans appel fournisseur. Les preuves et limites sont consignées dans la PR #5,
commentaire `5553696022`. Chromium/SwiftShader n'est pas un GPU matériel.
Voir `REFONTE_STAGE5.md` et ADR-005.

### Étape 6 — première tranche de streaming, PR #6 / Milestone 5

Fenêtres autour du joueur en mètres ECEF sur empreintes h=0 WGS84, prédiction,
rétention, ordonnanceur déterministe, révisions anti-ABA, workers et buffers
transférables. Ajouts/retraits incrémentaux des meshes et colliders ; les BVH
existants sont conservés. Le petit patch de spawn reste épinglé pour la réapparition.

64 cellules au plus ; deux workers synthétiques ou un worker Mapbox ; file et
réservations CPU limitées à 4 Mio. Cache CPU LRU et cache synthétique IndexedDB
optionnel ; Mapbox reste seulement en mémoire, preview-only, avec consentement
séparé et 256 tentatives HTTP supplémentaires au maximum par activation.
Le streaming est désactivé par défaut et s'active dans le panneau Monde continu.

32 nouveaux tests CPU passent localement ; les tests incluent 5 000 fenêtres
virtuelles et six minutes simulées de marche (>2,5 km) avec renouvellement des
cellules. La CI du commit `c82a231bdcb7d439b33f5bb7ca252a01f64c1f2a`, run
`33985087448`, a réussi sur Node 22/24, au build V1 et dans les parcours navigateur.
Le test de streaming utilise de vrais workers, IndexedDB et clavier, mais des
réponses Mapbox simulées. Il a observé 12 cellules ajoutées, 6 libérées et le
maintien du support après traversée du patch initial.

Ce premier parcours a aussi mesuré un `maxCommitMs` de 87,7 ms : l'intégration
sur le fil principal doit encore être optimisée. Le seuil de 4 ms n'est pas un
plafond préemptif. Ce constat ne doit pas être remplacé par une promesse de 60 FPS.
Les résultats exacts du dernier SHA et de sa publication sont consignés dans la
PR #6 ; les tests sont aussi ajoutés aux contrôles avant/après déploiement.
Voir `REFONTE_STAGE6.md` et ADR-006 pour le périmètre mathématique et les limites.

### Étape 7 — fenêtre glissante et recyclage chaud

Implémentation du plan validé : fenêtre logique 3×3, bande directionnelle de trois
cellules (cinq en diagonale), maintien de l'ancienne fenêtre jusqu'à disponibilité
de la suivante. Les cellules quittées gardent leurs meshes et BVH ; elles restent
cachées et exclues des collisions jusqu'à réactivation. Le rebase s'applique aussi
aux ressources cachées. Le départ est réactivé avant une réapparition.

Recyclage LRU de 12 cellules non protégées après éviction progressive ; plafonds
avant admission de 64 résidentes et 32 Mio de payloads comptabilisés. Ces octets
ne sont pas le heap total ou la mémoire GPU. Les modes métriques de l'étape 6,
le cache CPU, les workers et les garde-fous Mapbox restent disponibles.

26 nouveaux tests CPU réussissent localement. La CI doit exécuter les 245 anciens
et les 26 nouveaux, plus un parcours clavier de demi-tour, éviction et chargement
lent simulé. Les résultats effectivement obtenus et le SHA servi sont consignés
dans la PR de livraison ; ne pas inférer une publication du seul contenu du code.

Le 3×3 n'est pas un rayon constant en mètres. Cette tranche ne garantit pas des
chargements invisibles, n'introduit pas de LOD et ne sépare pas encore le terrain
Mapbox de son imagerie. Voir `REFONTE_STAGE7.md` et ADR-007.

## Ce qui reste à développer ou valider

- Finir le Milestone 5 : réduire les pics d'intégration, confirmer les sessions
  navigateur prolongées et le plateau mémoire global, valider le streaming live.
- Progression multicouche et terrain parent de secours ; LOD mixte et transitions.
- Sélection de résolution physique indépendante du LOD visuel.
- Routes, eau, landcover, bâtiments, arbres et décoration procédurale V2.
- Avatar animé, escaliers automatiques, tactile/gamepad et corps rigides généraux.
- Référentiel vertical réel canonique et conversion géoïde justifiée.
- Performances GPU matérielles et validation Safari.
- Le build racine signale des dépendances vulnérables préexistantes ; leur impact
  n'est pas évalué dans cette tranche et nécessite une revue dédiée, sans mise à
  jour automatique des lockfiles historiques.

Le streaming fonctionne comme préversion expérimentale ; le DoD complet du
Milestone 5 n'est pas déclaré terminé. Les couches vectorielles viennent ensuite.
Les 60 Hz de simulation ne constituent pas une promesse de 60 images par seconde.
