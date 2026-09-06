# Étape 11b — première application de profils aux données réelles

Base : `5a5c758012d2315deeeb30c65894be664ceb379c`. Cette tranche prolonge
PR11 ; PR12 était un correctif de surfaces, pas Road Structures.

## Périmètre, sans extrapolation

Une option expérimentale du laboratoire applique des profils estimés aux axes
Mapbox Streets et au relief Terrain-RGB. Le mode habituel reste inchangé.
Entrée : `/Zerana/v2/?source=mapbox&engineering=1&level=19`. Le streaming et la
marche sont automatiques ; aucun clic d'analyse routière. Niveau 19 ou 21,
32 subdivisions, latitude qualifiée pour l'estimation jusqu'à ±75°.

Ce n'est **pas** le solveur mondial achevé décrit dans la discussion. Les
recettes sont ancrées dans des régions géographiques fixes de niveau 16, et
non dans les WorldCells du joueur. Une bande fixe de 12 m les raccorde au DEM
brut. Cela garantit un choix de fonction stable entre cellules, mais réintroduit
localement le relief brut et ne certifie pas la pente routière aux transitions.
Les connexions restent cartographiques, non routables. Ce compromis de preview
est visible dans les diagnostics `fixed-raw-collar` / `qualifiedForDriving:false`.

## Génération

Une région charge son contexte vectoriel 3×3 au zoom 16 et le DEM couvrant
l'ensemble avec halo. Les corps exacts MVT/DEM sont identifiés par SHA-256.
Le graphe canonique existant ne change pas. Les axes compatibles au sol sont
regroupés tant que les tags concordent et les virages sont inférieurs à 20°.
Boucles, alignements trop courts/longs, budgets dépassés et profils incompatibles
restent explicitement différés. Ponts, tunnels, gués, escaliers et niveaux
superposés ne deviennent pas des routes terrassées au sol ; leur voisinage
protège aussi le relief brut.

Le solveur PR11 lisse les stations métriques, conserve le datum non résolu,
calcule bombement/dévers estimés et vérifie ses bornes longitudinales. Une
emprise transversale est échantillonnée avant admission ; un dépassement
constaté pendant l'évaluation rejette le paquet entier, sans clamp local.
Les jonctions compatibles reçoivent une référence plane commune lorsque le
relief échantillonné le permet. Les largeurs et la vitesse de conception de
6 m/s sont des choix de simulation, jamais des mesures de la route.

Le terrain final sert à construire **les mêmes triangles** pour le rendu et le
collider ; les surfaces PR10 s'appuient sur ce terrain final. Aucun collider
routier superposé. Meshes et collider sont préparés avant admission physique ;
une cellule en attente ne remplace jamais une cellule déjà jouable. Lors d'un
changement de monde, les paquets CPU sont prêts avant abandon de l'ancien sol ;
un échec de création GPU désactive le joueur plutôt que garder un ancien
collider sous une nouvelle scène.

## Révisions, streaming et coût

Les ensembles de lectures et révisions de recettes sont comparés à **toutes**
les cellules retenues, pas seulement aux voisines visibles. Des réponses
incompatibles sont refusées ; aucun terrain n'est recalculé sous le joueur.
Ces garanties portent sur la cohorte résidente, pas sur un snapshot mondial
immuable du fournisseur. Une nouvelle session peut recevoir des données neuves.

Un seul worker prépare terrain, routes et BVH, avec caches réutilisés dès le
départ. Le recyclage garde le paquet complet. Les budgets PR10 sont conservés :
2 Mio par surface, 8 Mio de surfaces résidentes ; un paquet complet de streaming
reste limité à 1 Mio. Les recettes ont une comptabilité estimée de 32 Mio / 4
régions ; les caches de tuiles compressées et vectorielles sont chacun bornés à
16 Mio. La mémoire temporaire du calcul et le heap du navigateur ne sont pas
ces seuls payloads. Pas de stockage Mapbox sur disque, pas de token dans les
sources/rapports. Les appels MVT et DEM comptent dans le même quota de 256,
incluant le départ lors de la première activation. L'imagerie reste secondaire.

## Limites avant une qualification de conduite

La projection tangentielle, les polylignes cartographiques, la résolution du
DEM et la grille physique sont des approximations. Le profil longitudinal
isolé est C1 ; la composition de plusieurs bandes/planes n'est pas une preuve
C1 ou de pente/dévers réglementaire sur toute la chaussée. Les références de
jonction et de raccord brut sont estimées, pas des observations. Les zones
complexes peuvent rester au relief brut ou refuser une cellule ; le sol déjà
valide reste disponible. Pas de promesse de 60 FPS, de qualité ETS2 ou de
couverture mondiale. La suppression du collier régional, des jonctions
verticales plus élaborées et un contrôle d'erreur adaptatif restent à développer.

## Validation

La CI doit exécuter tous les tests antérieurs et le nouveau parcours PNG/MVT
simulé : chargement sans bouton, modification réelle de la hauteur, BVH préparé,
marche, retour, rebase, annulation et refus fournisseur. Un test séparé doit
vérifier de vraies données Mapbox avec un plafond d'appels externe. Le SHA
publié et les rapports seront consignés dans la PR après exécution. La présence
ce document n'est pas une preuve que le déploiement est déjà validé.
