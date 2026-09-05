# État de la refonte Zerana V2

## Baseline protégée

- Commit de départ : `0e06c350b6c3d07699600e0003609790d60661c4`.
- Sauvegarde Git distante : `legacy/v1`.
- Noyau initial : `feature/v2-geo-kernel`, PR #1.
- Tranche terrain : `feature/v2-synthetic-terrain`, basée sur `dd1c533e928f16d65633a3d31cc711dda3076eb7`.
- Référence fournie : `ZERANA_ARCHITECTURE_REFERENCE(1).md`, version 1.0.0.
- SHA-256 du fichier fourni : `8fa7d13540eef938c423a83fc6e207743e48e9c9c9c33432eb10979979ce56f8`.
- Le moteur racine, ses assets, ses dépendances et son déploiement ne sont pas remplacés.
- La copie locale du Mac n'est pas modifiée.

## Première tranche — noyau

Implémenté dans `v2/src/geo/` : unités typées, WGS84, conversions ECEF/ENU,
repère Three, transformations d'origine flottante, Mercator et IDs de cellules.
Les 80 tests existants et les fixtures PROJ sont conservés, sans changement du noyau.
La première CI avait validé Node 22/24 et la compilation du jeu existant.

## Deuxième tranche — terrain synthétique

Implémenté : source synthétique ellipsoïdale explicite, cache de samples borné,
grille canonique dyadique, vertices et normales avec halo, packets CPU,
génération de 1/4/9 cellules, métriques de raccord, démo Three.js isolée.
Le déplacement de l'origine transforme la caméra et les racines sans recréer
les buffers. La capsule de 1,80 m est un repère, pas un joueur physique.

59 nouveaux tests terrain ont été exécutés dans l'environnement de travail,
avec 24 références ECEF indépendantes produites par PROJ 9.5.1 / pyproj 3.7.2.
Les fichiers du noyau utilisés localement ont été vérifiés par leurs blobs Git.
Les nouveaux tests couvrent notamment winding, UV, cache, indices Uint32,
antiméridien, limites Mercator, ordre de génération et 100 changements de repère.

Contrôle supplémentaire sur six zones, 9 cellules L15/N32 :
- écart maximal de raccord, vertices Float32 et transforms CPU Float64 : 0,00006102 m ;
- estimation illustrative des opérations Float32 : 0,00037129 m.
Ce sont des résultats échantillonnés, pas une preuve globale ni une mesure de GPU.

La CI de cette branche vérifie les 80 + 59 tests sur Node 22/24, le build du jeu
existant et la démo sous `/Zerana/v2/` avec Chromium/SwiftShader. Elle conserve
captures et résultats en artifact. Le résultat effectif de chaque commit et ses
limites sont consignés dans la PR ; un workflow ajouté n'est pas considéré comme
réussi tant que son exécution n'est pas terminée.

## Ce qui n'est PAS terminé

- Aucun terrain réel DEM/satellite n'est encore branché en V2.
- Pas de contrôleur joueur, collider ou runtime physique rebasé.
- Pas de streaming, workers, cache persistant, LOD mixte ou couches vectorielles V2.
- Les patches synchrones ne démontrent pas la fluidité en déplacement.
- Les cycles de destruction navigateur ne remplacent pas un test de plusieurs heures.
- Aucun benchmark GPU matériel ni support de tous les navigateurs n'est revendiqué.
- Aucun nouveau jeu V2 n'est publié par cette branche.

## Suite

Après validation de cette tranche : contrat d'élévation réelle et de son datum,
échantillonnage raster testé, puis imagerie géoréférencée. Ne pas brancher le
streaming ou les façades avant d'avoir validé cette superposition.

Formules et limites : `adr/ADR-002-synthetic-terrain-patches.md`.
Utilisation de la démo : `../v2/demo/README.md`.
