# Livraison PR10 / PR11 — critères et périmètre

## PR10 : défaut réel à fermer

Le déploiement `7ad70eeddf993a5a0d9486da71f3e5c62b452700` avait réussi,
mais son contrôle Mapbox réel a échoué sur `ROAD_SURFACE_VERTEX_BUDGET`.
Le nouveau format indexe seulement des tuples GPU Float32 exactement identiques.
Il conserve les triangles, les limites de sommets uniques, 2 Mio par paquet et
8 Mio de payloads routiers résidents. Une fixture dense et trois empreintes de
buffers développés couvrent cette correction.

La fermeture exige le parcours **réel** `road_surface_live.py` sur les neuf
cellules de départ à Paris, niveau 17, puis marche/retour et réutilisation des
ressources. Aucun changement de lieu ou de niveau ne doit contourner le défaut.
Le test conserve son plafond externe de 128 tentatives Mapbox (raster + routes),
distinct des budgets du jeu et de la facturation globale du compte.

## PR11 : tranche livrable, limites explicites

PR11 livre le noyau de profils et la piste synthétique de validation décrits dans
[ADR-011](adr/ADR-011-road-engineering.md) et [le guide](REFONTE_STAGE11.md).
Elle ne termine **pas** tout le Road Engineering mondial annoncé en discussion.
Le terrassement Mapbox reste désactivé : corridors stables, états de jonction,
révisions DEM partagées et publication atomique terrain/route/collider restent
nécessaires avant activation sur des données réelles.

Le parcours synthétique doit valider déplacement, retour, rebase, source brute
séparée et support physique. Un test additionnel mesure 2 107 rayons sur toute
la piste de 1 200 m, de la couronne aux raccordements latéraux, au niveau 19 et
32 subdivisions. Sa borne de discrétisation de 10 cm n'est ni une norme de
conception routière, ni une relaxation du raccord inter-cellules de 1 mm.
Les valeurs maximales et RMS réellement mesurées apparaissent dans les logs.

## Validation de livraison

Tous les tests antérieurs restent actifs. La CI doit réussir sur la tête exacte,
puis le workflow Pages doit vérifier le SHA servi, rejouer les parcours sur le
domaine public et effectuer le contrôle Mapbox réel activé explicitement.
Les résultats, captures et limites constatés sont consignés dans la PR11 et
reliés depuis la PR10 après exécution. La présence de ce document ne signifie
pas que la livraison est déjà validée.

V1, Geo Kernel, lockfiles, ressources historiques et dépôt local utilisateur ne
sont pas modifiés par cette reprise. Aucun token ne doit apparaître dans les
rapports ou les sources.
