# PR15b — Correctif du niveau d’eau et validation à hauteur du joueur

Base publiée : `decc600b24c8eba1c565a74fa8f9a7c2d9a06cae`.
Périmètre : mode `hydro=1`, L19/L21, 32 subdivisions. Pas de nouvelle feature
Landcover, de pont, de nage, de collider d’eau ni de changement du Geo Kernel.

## Défaut et correction

`maxTerrainAboveWaterMeters <= 0` excluait le terrain traversant l’eau, mais
acceptait aussi une surface située arbitrairement au-dessus du sol. La médiane
de 25 taps ne bornait pas les dépressions entre ces taps ou le niveau des berges.

Le correctif conserve le DEM brut. `TerrainHeightSource.heightBounds` est une
capacité optionnelle, pure, bornée, portant sur le **même** référentiel vertical
que `heightAt`. Le raster bilinéaire fournit une enveloppe conservative : tous
les texels contribuant au rectangle sont inclus, sans ignorer nodata ou défaut
de couverture. Une conversion géoïde arbitraire ne reçoit pas cette capacité.

Pour chaque nœud hydro mondial, le profil prend le minimum de l’estimation et
de l’enveloppe basse du support complet des triangles incidents. La grille
hydro fixe passe de 16 à 64 divisions par région dans le seul mode conditionné ;
aucun collier terrestre supplémentaire n’élargit ce support pour les eaux
ouvertes. Cela empêche une dépression ponctuelle d’abaisser des berges éloignées. Un inset de profil de 0,10 m est explicite,
**pas** un déplacement du mesh après génération. Avec des poids barycentriques
positifs, chaque triangle de ce profil reste sous l’enveloppe DEM qui le couvre.
Les supports et nœuds sont indépendants du découpage des WorldCells et de leur
ordre d’arrivée. Les niveaux des petits bassins fermés restent uniques, mais
sont bornés par les bandes de berge complètes plutôt que leur médiane seule.
Un fond naturel profond de bassin fermé n’est pas rehaussé.

La source conditionnée creuse ensuite le terrain sous ce profil avec les
clearances PR15b de 0,25/0,50 m. Le terrain et le collider sont toujours issus
des mêmes buffers. Le plafond de baisse reste 12 m ; un cas non représentable
est refusé. Aucun budget n’est relevé, aucun shader ne masque un conflit.
La version `hydro-conditioned-v2` invalide correctement les anciennes cohortes.

## Contrôles ajoutés

Le certificat des triangles complets calcule désormais les deux extrema :
minimum de séparation **et maximum de colonne eau/terrain**. Un second passage
sur la représentation brute, dans le même repère cellule, mesure
`maxWaterAboveRawTerrainMeters`. Il n’est ni rendu ni utilisé comme collider.
Les surfaces ouvertes au-dessus du terrain brut sont refusées. Les bassins
fermés peuvent avoir un fond plus profond ; leur contrainte vient des berges.

Le diagnostic expose ces deux mesures sans rendre de tableaux DEM publics.
Une sonde manuelle en lecture seule interroge les triangles sous les pieds et
sous la caméra ; elle ne fait aucun travail supplémentaire à chaque frame.
Le test navigateur photographie la caméra réelle du personnage avant la vue
d’ensemble et au retour. Sur la sonde Seine, les pieds doivent être hors de
l’eau et la surface voisine sous la caméra. Les anciens tests de 70 m, retour,
recyclage, trois rebases, collisions, couverture et visibilité sont conservés.

Tests CPU : enveloppe bilinéaire, creux entre taps, antiméridien, nodata,
couverture et budgets ; incompatibilité des référentiels ; plafond flottant que
l’ancien certificat acceptait ; creux intérieur ; distinction rive/sous-eau.
Tests adaptateurs : profil plafonné, absence/enveloppe invalide, ordre de régions.
Le test réel reste borné à 256 tentatives Mapbox, preuves assainies uniquement.

## Qualification

C’est une représentation de prévisualisation conservatrice, pas un niveau de
Seine mesuré, une bathymétrie ou un solveur hydraulique. Un DEM fortement
contradictoire peut imposer un refus plutôt qu’une correction arbitraire.
Un joueur entré dans un fond réellement profond peut encore être sous l’eau :
la nage n’est pas implémentée. Ce cas ne se confond pas avec une eau au-dessus
d’une rive sèche. `hydro=0`/mode historique et `engineering=1` restent distincts.
Les résultats CI/live/publics et captures sont consignés dans la PR du correctif.

## Garde-fou du déplacement et coût de la grille

Les glissements/résolutions de collision peuvent déplacer la capsule au-delà
du déplacement demandé. Le résultat physique est désormais revérifié avant
sa validation : sans support dans la fenêtre active, la pose ECEF précédente
est conservée et la vitesse annulée. Pas de sol invisible ni de collider d’eau.
Le joueur reprend lorsque les cellules nécessaires deviennent disponibles.

La grille hydro 65×65 (Float64) est imputée au cache régional de 16 Mio existant.
Les mémos gardent leurs plafonds de 4 096/2 048 entrées avec éviction et recalcul
pur ; le terrain conserve ses 32 subdivisions. Les plafonds des paquets, du
nombre de sommets/triangles et des opérations ne sont pas augmentés. La grille
historique de PR15 reste à 16. Un échec de cohorte reste explicite.
