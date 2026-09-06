# ADR-011 — Profils de corridor et terrassement avant admission physique

Statut : implémentation expérimentale ; activation synthétique uniquement.
Date : 2026-09-06. Base : PR10 / `7ad70eeddf993a5a0d9486da71f3e5c62b452700`.

## Décision

Un profil appartient à un corridor géographique versionné, jamais à une cellule
ou à une fenêtre de streaming. Les stations, hauteurs et pentes d’extrémité
portent des identités explicites. Le solveur reçoit un référentiel vertical ;
une donnée Mapbox non résolue ne devient pas une hauteur WGS84 certifiée.
La même surface aménagée doit produire rendu et collisions avant admission.

Le premier adaptateur est une piste synthétique fixe, accessible dans le
laboratoire existant. Il prouve le chemin source → terrain → collider →
streaming, sans écraser tardivement le terrain sous le joueur. Il ne déduit
aucun corridor d’un simple croisement des lignes cartographiques Mapbox.

## Modèle et formules

`s` : distance horizontale curviligne en mètres, à origine fixe de corridor.
`t` : distance horizontale transversale en mètres, positive vers la gauche.
`h` : hauteur en mètres dans le datum déclaré. Les largeurs sont horizontales,
pas des longueurs mesurées sur une chaussée inclinée. Pas d’échelle Mercator
appliquée au joueur ; les adaptations géographiques utilisent le Geo Kernel.

Pour des stations uniformes espacées de `ds`, altitudes source `r_i` et altitudes
lissées `h_i`, minimiser :

```
J(h) = Σ (h_i - r_i)² + μ Σ (h_i - 2 h_(i+1) + h_(i+2))²
μ = (smoothingLengthMeters / ds)⁴
h_0 = r_0 ; h_(n-1) = r_(n-1)
```

Les deux termes de J ont l’unité m². La matrice libre est symétrique définie
positive : identité plus `μ D2ᵀ D2`. Son demi-bandwidth vaut 2 ; une factorisation
de Cholesky bandée exige O(n) travail/mémoire. On contrôle aussi le résidu après
résolution. Il n’y a ni convergence itérative présumée ni lissage cellule par
cellule. Les profils affines appartiennent au noyau de D2 et sont conservés.

Pour chaque intervalle de longueur `L = ds`, avec hauteurs `h0,h1`, pentes
`m0,m1` et `d = (h1-h0)/L` :

```
a = h0
b = m0
c = (3d - 2m0 - m1) / L
e = (m0 + m1 - 2d) / L²
h(x) = a + b x + c x² + e x³ ; 0 ≤ x ≤ L
h'(x) = b + 2c x + 3e x²
h''(x) = 2c + 6e x
```

Unités : a en m ; b sans dimension ; c en m⁻¹ ; e en m⁻². Les pentes intérieures
sont les moyennes harmoniques des sécantes de même signe, sinon zéro. Les pentes
d’extrémité sont des contraintes explicites du corridor. Ce profil est C1, pas
C2 en général. Les valeurs absolues de h' sont évaluées aux extrémités et à
`x=-c/(3e)` lorsqu’il appartient à l’intervalle. Les extrêmes de h'' sont aux
extrémités. Les extrêmes du déblai/remblai par rapport à l’interpolation linéaire
des stations brutes sont trouvés avec les racines de `h'(x)-r'(x)=0`.

Le contrôle longitudinal porte sur la ligne de référence et l’interpolation
des stations source, pas sur tout le DEM ni tous les points du terrassement.
Un dépassement rend `structure-required`, sans profil autorisé à être publié.
Le choix d’un ouvrage réel n’est pas inférable à partir de ce seul échec.

Dévers expérimental `b(s)` et bombement `crown(s)` :

```
b_target = -clamp(κ v_design² / g, -b_max, b_max)
g = 9.80665 m/s²
crown(s) = c0 [1 - min(1, (b(s)/b_max)²)]
h_road(s,t) = h_profile(s) + b(s)t - crown(s)|t|
```

κ est en m⁻¹, positive dans un virage à gauche. À vitesse positive et courbure
positive, l’intérieur gauche est plus bas : le signe moins est intentionnel.
κ inconnue donne zéro dévers, pas une courbure inventée. La valeur constante de
g sert au modèle de jeu ; ce n’est pas une mesure gravimétrique locale. Les
stations de dévers sont interpolées en C1 avec pentes terminales nulles. La
forme quadratique du bombement évite une cassure lors du passage de b par zéro.
Le centre du bombement peut conserver une arête de couronne à t=0.

Transition de terrassement avec demi-largeur w/2 et bande B :

```
S(u) = 6u⁵ - 15u⁴ + 10u³ ; u clampé dans [0,1]
alpha_t = 1 - S(max(0, |t|-w/2) / B)
alpha_s = S((s-s_start)/E) S((s_end-s)/E)
h_final = h_raw + alpha_s alpha_t (h_road_extended - h_raw)
```

`h_road_extended` prolonge le profil transversal à travers la bande. S a ses
deux premières dérivées nulles aux bornes. Le blend rejoint exactement le brut
à la limite fixe du support ; il ne suit pas le joueur. Les raccordements
terminaux reviennent au brut et ne portent pas une garantie générale de pente
routière. Un échantillon dont le déblai/remblai dépasse la politique rejette la
transaction entière ; choisir raw pour ce seul point créerait une discontinuité.

## Budgets et approximations

3 à 1 025 stations ; pas de 0,5 à 16 m ; longueur ≤ 8 192 m ; μ ≤ 10⁷ ;
hauteurs absolues ≤ 100 km. Les valeurs de politique sont des limites de jeu
versionnées, pas une norme routière française, marocaine ou autre.
Le banc d’essai adopte un arc de rayon 650 m sur 1,2 km, largeur 7 m, pas 4 m,
bande de raccordement 18 m. Son ancrage ECEF/ENU est fixe ; les rebases du rendu
ne modifient pas les évaluations. La projection tangentielle et la quantification
MVT de son tracé ne constituent pas une mesure géodésique d’une route réelle.

Les triangles rendus/collisionnés restent ceux de la grille V2. Leur interpolation
est une approximation de la fonction aménagée : les tests de raccord ne prouvent
pas une représentation exacte de tous les dévers/bombements. Le niveau 19 est
utilisé pour le parcours de validation, sans relever la capacité des colliders.

## Densité des surfaces PR10

L’échec public `ROAD_SURFACE_VERTEX_BUDGET` est traité par indexation des tuples
Float32 complets, pas en relevant arbitrairement le budget. Aucun triangle n’est
supprimé ou changé. 24 000 vertices uniques, 24 000 triangles, 2 Mio par paquet,
8 Mio résidents. Les coûts des maps de déduplication sont temporaires dans le
worker ; le budget des payloads n’est pas une mesure exhaustive du heap.

## Critères avant le réseau réel

Contexte DEM complet et cohérent ; corridors/topologie suffisants ; états de
jonction partagés ; domaine d’influence géographique déterministe ; cohorte de
publication physique atomique ; politique explicite pour les capsules déjà
présentes ; refus des conflits de révision ; métriques d’erreur de maillage.
Ces prérequis ne sont pas remplacés par le banc d’essai. Le réseau Mapbox garde
le comportement PR10 : surfaces drapées, sans terrassement automatique.

## Références

- ASAM OpenDRIVE 1.8.1, *Road elevation methods* : distinction profil longitudinal,
  élévation latérale, polynômes et superelevation. Inspiration terminologique,
  pas une conformité OpenDRIVE ni un export de ce format.
  https://publications.pages.asam.net/standards/ASAM_OpenDRIVE/ASAM_OpenDRIVE_Specification/v1.8.1/specification/10_roads/10_05_elevation.html
- Zerana, `architecture/ZERANA_WORLD_ENGINE.md`, §§4–8 et 26–27 : unités, datum,
  coordonnées cellule, origine flottante et critères de validation.
- NumPy : oracle indépendant dense stocké dans
  `v2/tests/fixtures/engineering-dense-reference.json` ; aucune dépendance Python
  ajoutée au runtime ou aux tests JavaScript.
