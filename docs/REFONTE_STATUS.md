# État de la refonte Zerana V2

Ce document décrit le code présent. Pour identifier la version effectivement publiée,
consulter le manifeste servi par Pages et le dernier workflow de déploiement réussi.
Une PR ouverte ou une compilation réussie ne prouve pas une publication fonctionnelle.

## Baselines et protection

- Prototype V1 : `0e06c350b6c3d07699600e0003609790d60661c4`, branche `legacy/v1`.
- Première préversion V2 publiée : `07ac40b699d2f200e1dd21b3f4900c9d0be827fd`.
- Jeu historique : `/Zerana/` ; laboratoire indépendant : `/Zerana/v2/`.
- Les sources V1, assets historiques et lockfiles ne sont pas modifiés par l'étape 5.
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

33 nouveaux tests CPU ont passé dans l'environnement de travail. La CI exécute les
213 tests cumulés sur Node 22/24, les anciens parcours navigateur et le nouveau
scénario clavier/souris. Le statut exact du dernier SHA et du déploiement est
consigné dans la PR #5, et ne doit pas être déduit de la seule présence des tests.
Le navigateur local bloque HTTP ; les preuves navigateur proviennent de GitHub
Actions, sous Chromium/SwiftShader. Voir `REFONTE_STAGE5.md` et ADR-005.

## Ce qui reste à développer ou valider

- Streaming continu, workers, ordonnanceur, cache et sécurité des cellules futures.
- Sélection de résolution physique indépendante du LOD visuel, transitions de LOD.
- Routes, eau, landcover, bâtiments, arbres et décoration procédurale V2.
- Avatar animé, escaliers automatiques, tactile/gamepad et corps rigides généraux.
- Référentiel vertical réel canonique et conversion géoïde justifiée.
- Tests longs de mémoire, performances GPU matérielles et validation Safari.
- Le build racine signale des dépendances vulnérables préexistantes ; leur impact
  n'est pas évalué dans cette tranche et nécessite une revue dédiée, sans mise à
  jour automatique des lockfiles historiques.

Prochain jalon : **Milestone 5 — streaming progressif**, avant les couches vectorielles.
Les 60 Hz de simulation ne constituent pas une promesse de 60 images par seconde.
