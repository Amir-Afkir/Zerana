# ADR-005 — Joueur métrique, collisions de terrain et origine flottante

Date : 2026-09-05. Statut : proposé pour validation CI et navigateur.
Base : `07ac40b699d2f200e1dd21b3f4900c9d0be827fd`.
Référence inchangée : `docs/architecture/ZERANA_WORLD_ENGINE.md`, sections 4.8, 5,
8.6, 13 et Milestone 4. Cette tranche ne réalise pas le streaming du Milestone 5.

## Décision

Le laboratoire reçoit un contrôleur cinématique à capsule. Il n'y a qu'un joueur
logique (`MetricPlayer`) : position des pieds ECEF en nombres JS Float64, vitesse
ECEF, cap géodétique, inclinaison de caméra, état au sol. Les poses locales de
collision, de caméra et du mesh sont dérivées, jamais des autorités concurrentes.

Le noyau géographique n'est pas modifié. `runtime/` dépend de `geo/` et du contrat
`physics/`. Ni Three.js, ni DOM, ni réseau dans ces deux domaines CPU. Le navigateur
reste un adaptateur dans `v2/demo/runtime/`. Aucune dépendance ou lockfile ajouté.

## Unités, temps et orientation

- Capsule : hauteur totale 1,80 m, rayon 0,30 m. Échelle du rendu constamment 1.
- Marche 4 m/s, course 7 m/s : norme de la commande tangentielle horizontale.
  La projection de collision peut réduire la vitesse effective sur une pente.
- Entrée diagonale divisée par `max(1, hypot(forward, right))`.
- Gravité de jeu uniforme 9,81 m/s², pas un modèle gravimétrique terrestre.
- Impulsion de saut 5 m/s, vitesse terminale 30 m/s ; saut sur front montant.
- Pas physique fixé à 1/60 s. Un delta d'affichage est plafonné à 0,1 s ; au plus
  six pas par frame. Le temps écarté est mesuré. Pause/blur/onglet caché effacent
  le reliquat, sans rattrapage du temps passé en arrière-plan.
- À la latitude phi et longitude lambda des pieds : Up est la normale ellipsoïdale
  `(cos(phi)cos(lambda), cos(phi)sin(lambda), sin(phi))`.
  Forward = North cos(cap) + East sin(cap) ; Right = East cos(cap) - North sin(cap).
  Ces vecteurs sont transformés par rotation seulement vers le repère actif.

Les petits déplacements sont convertis vers ECEF par le Geo Kernel existant.
Après collision, la nouvelle pose ECEF est publiée ; la vitesse ECEF décrit le
déplacement effectivement résolu pendant le pas. Les poses précédente/courante
sont interpolées en ECEF avant projection locale pour l'affichage.

## Collision : géométrie, balayage et budgets

Pour pieds F, Up unitaire U, hauteur H, rayon r, les centres des hémisphères sont :

```text
A = F + r U
B = F + (H-r) U
```

La capsule est la somme de Minkowski du segment AB et d'une sphère de rayon r.
La distance segment-triangle examine la traversée de face, les deux extrémités
contre le triangle et les trois paires segment/arête. Le rayon effectif de contact
est `r + 0,015 m` (skin), avec tolérance numérique de 1e-6 m.

Chaque cellule possède un BVH de triangles COPIÉS en coordonnées locales. Les
changements de matrices du rendu, la mutation ou la libération de ses buffers ne
modifient pas le collider. La résolution initiale est celle du mesh installé :
la représentation et sa durée de vie sont indépendantes, mais un choix de LOD
physique réellement indépendant du LOD visuel reste à implémenter avec le streaming.

Balayage continu d'une translation D, orientation fixe pendant le balayage :
à la position courante, distance d et normale séparatrice n, la distance au plan
support de l'obstacle dilaté est `gap = d - (r + skin)`. Si `closing = -n·D > 0`,
`gap / closing` est une borne inférieure du temps de contact avec ce plan. Prendre
le minimum sur les candidats BVH, avancer de 0,999 fois cette borne, puis recalculer
la distance exacte. Une direction non entrante ne peut traverser son plan support.
À un contact, retirer la composante entrante du déplacement restant :

```text
D_slide = D - min(0, D·n) n
```

Le solveur est borné : 32 itérations par balayage, cinq glissements, huit corrections
d'interpénétration initiale et 4 096 triangles candidats. Un reste non démontré
n'est jamais appliqué. Une interpénétration initiale > 0,25 m n'est pas corrigée
silencieusement. Les déplacements > 100 m par requête sont refusés. Le contrôleur
normal avance de moins de 0,52 m par pas, même en chute à vitesse terminale.
Maximum : neuf colliders et 131 072 triangles au total. Une scène plus détaillée
peut rester visualisable, avec marche indisponible et explication explicite.

Les pentes franchissables vérifient `n·U >= cos(45°)`. Une pente plus raide ne
convertit pas la commande horizontale en escalade ; la composante verticale est
retestée depuis la pose sûre. Un snap descendant maximal de 0,25 m maintient le
contact sur les descentes, uniquement si déjà au sol et sans saut.

Les rayons de support admettent une marge de bord **2e-5 m**, convertie en tolérance
barycentrique par les hauteurs du triangle. Elle absorbe les petits écarts Float32
au coin de quatre cellules. Le test d'intersection interne au balayage capsule ne
reçoit PAS cette marge. Ce n'est ni un comblement des données manquantes ni une
certification universelle des raccords.

## Sécurité du patch chargé

Neuf sondes sous l'empreinte (centre + huit directions à rayon r+0,05 m) vérifient
qu'il reste du terrain chargé. Sans support, la composante horizontale s'arrête,
la gravité et les contacts du terrain existant continuent. Aucun nouveau terrain
n'est demandé. Ces sondes constituent un garde-fou opérationnel pour les patches
rectangulaires du laboratoire, pas une preuve de couverture de tout polygone
arbitraire. Pas de marche au-dessus du vide en attente d'une cellule future.

## Caméra et rebase

Caméra de poursuite : cible à 1,35 m, recul nominal 5,5 m, sphère de protection de
rayon 0,15 m, near 0,1 m et far 5 000 m pendant la marche. La sphère est balayée de
la cible vers la position désirée avec le même solveur. Aucun raycast Three.js
concurrent et aucune double position de joueur.

Rebase normal à 2 048 m horizontaux ; seuils 256 et 32 m disponibles UNIQUEMENT
comme réglages explicites de test. Le rebase automatique prend l'ancrage du joueur.
Le bouton historique décale volontairement l'origine de 512 m pour le diagnostic.

Entre les pas physiques et avant le rendu : préparer toutes les transformations
colliders, modifier l'ancrage actif, recalculer les racines de cellules, la capsule
et la caméra. Positions ECEF, vitesse ECEF, cap et historique d'interpolation restent
inchangés. Les BVH, les géométries GPU et leurs sommets ne sont pas reconstruits.
Le callback de frame est unique dans TerrainView ; pas de deuxième boucle RAF.

## Altitudes et périmètre

Le chemin normal exige `altitudeAuthority: ellipsoidal` avec référence déclarée
WGS84. Les paquets Mapbox `preview-only` restent refusés sauf opt-in explicite du
laboratoire déjà défini par ADR-003. La marche y est expérimentale sur la surface
AFFICHÉE ; elle ne transforme pas ces altitudes en données certifiées. Ni production
canonique, ni validation d'altitude absolue ne sont revendiquées.

Pas encore : escalier automatique, rigid bodies, bâtiments/arbres/routes, animations
GLB, tactile/gamepad, streaming, workers ou choix séparé de LOD physique. Le joueur
est volontairement une capsule visible. Le moteur et les ressources V1 ne changent pas.

## Validation attendue

33 nouveaux tests CPU : régions géométriques, murs fins et coin, collision caméra,
limites d'entrée, isolation des buffers, autorité d'altitude, repos, déplacement,
saut, pentes, bord de patch, 30/60/144 FPS, temps suspendu, 500 rebases et marche sur
les cellules géographiques à cinq positions, dont équateur et antiméridien.

Les tests navigateur utilisent de vraies touches/flèches et gestes souris : marche,
saut, rebase automatique et manuel, blur, bord d'une petite cellule, respawn, disposal.
Ils refusent toute requête externe. Exécution sur build au préfixe Pages puis sur
le site publié. Les 180 tests antérieurs restent présents. Résultats exacts dans
la PR et les artifacts CI ; ne pas conclure au succès avant de les lire.

Référence API rendu consultée : documentation officielle Three.js Matrix4 / Camera.
https://threejs.org/docs/pages/Matrix4.html
https://threejs.org/docs/pages/Camera.html
Les conventions et les formules géographiques proviennent de la référence Zerana,
les formules du contrôleur sont explicitées ci-dessus et couvertes par les tests.
