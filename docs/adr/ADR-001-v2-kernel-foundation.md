# ADR-001 — Fondation V2 isolée et contrats mathématiques de la tranche 1

Date : 2026-09-05. Statut : proposé pour intégration avec la première PR V2.

## Référence et portée

La référence est `docs/architecture/ZERANA_WORLD_ENGINE.md`, version 1.0.0 fournie
par Amir. Cette ADR précise sa première mise en œuvre ; elle ne déclare pas les
milestones terrain, streaming, physique ou performances terminés.

Le dépôt a évolué depuis l'audit V1 : sa baseline est désormais
`0e06c350b6c3d07699600e0003609790d60661c4`, avec le moteur `src/engine/WorldEngine.js`
et les bâtiments/arbres. Ne pas appliquer aveuglément la liste historique de
suppression de fichiers de la référence.

## Isolation et réversibilité

Le package `v2/` possède son propre package.json et lockfile. Aucun fichier sous
`src/`, `public/`, ni le workflow Pages existant n'est modifié dans cette tranche.
`legacy/v1` conserve la baseline distante. `main` ne devient pas automatiquement
une version V2 jouable : la bascule attend une tranche verticale validée.

## Précisions mathématiques explicites

1. Une unité représente un mètre. Aucun facteur de latitude n'est appliqué au
   joueur dans le noyau V2. Cela ne modifie pas encore le comportement du moteur V1.
2. La hauteur utilisée par WGS84 → ECEF est ellipsoïdale. Aucun DEM de référentiel
   inconnu n'est converti par hypothèse ; l'intégration des datums est future.
3. L'inverse ECEF est validé dans h ∈ [-12 000 ; 100 000 000] m. Le centre de la
   Terre, les points profondément internes et les entrées non finies sont rejetés.
   L'axe polaire utilise une longitude conventionnelle de 0. On ne retourne jamais
   une itération non convergée comme si elle était valide.
4. Bowring initialise l'inverse, puis l'itération de latitude de la référence est
   utilisée. Le calcul d'altitude final adopte la forme stable équivalente :

   `h = p cosφ + Z sinφ - a sqrt(1 - e² sin²φ)`

   Elle vient de la projection de P sur la normale (cosφ, sinφ), puisque la
   projection du point ellipsoïdal est `a sqrt(1 - e² sin²φ)`. Elle évite la
   division par cosφ aux hautes latitudes. Tolérance angulaire : 10^-12 rad ;
   au plus 16 itérations par défaut. Une erreur d'arrondi inférieure à 10^-6 m
   est absorbée uniquement aux bornes déclarées du domaine d'altitude.
5. La matrice ENU et la permutation Est/Haut/Sud suivent exactement la référence.
   Le stockage `Float64Array` de son exemple d'interface est remplacé ici par
   un tuple immuable de 9 nombres JavaScript (toujours double précision), row-major.
   Cela rend les dimensions vérifiables par TypeScript et évite une mutation
   accidentelle des ancrages. Ce changement est de représentation, pas de formule.
6. Mercator est un adaptateur de cellules, pas la métrique physique. Hors
   ±atan(sinh π), il retourne une erreur : pas de clamp silencieux de position.
   À v=1, la dernière ligne porte fractionY=1. À +π, les points se normalisent
   vers -π, mais la borne Est d'un intervalle peut rester +π.
7. `frameTransform` est une transformation rigide pure. Son application atomique
   aux orientations, poses interpolées, vitesses et colliders n'est pas encore
   intégrée. Le seuil de 2048 m est un paramètre initial, pas un résultat de profilage.

## Validation et limites

Les références de conversion viennent de PROJ, explicitement avec WGS84 et non
le GRS80 par défaut. Les fixtures incluent des pas de surface calculés avec une
solution géodésique indépendante : un test de round-trip seul ne suffit pas.
Les tolérances calculées ne signifient pas que les données cartographiques réelles
ont une précision millimétrique.

Les tests de rebase vérifient les transformations numériques, pas un changement
de repère en plein rendu WebGL. Les bornes partagées ne prouvent pas encore
l'identité des samples DEM, normales, textures ou colliders de deux terrains.

Sources primaires consultées :
- https://proj.org/en/stable/operations/conversions/cart.html
- https://proj.org/en/stable/operations/conversions/topocentric.html
- https://www.typescriptlang.org/tsconfig/strict.html
- https://vite.dev/guide/static-deploy.html#github-pages

## Ordre suivant

Après cette PR : une cellule synthétique métrique avec grille de debug, puis
4/9 cellules et leurs samples partagés. L'imagerie et le DEM réel arrivent après
ces tests. Aucun changement esthétique ou refactoring massif du moteur V1 ici.
