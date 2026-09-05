# Noyau géospatial Zerana V2 — tranche 1

Ce package ne remplace pas encore le moteur de jeu. Il implémente les
transformations mathématiques de référence avant d'ajouter terrain et streaming.

## Vérifier

```sh
npm ci
npm run check
```

`check` lance le lint d'architecture ciblé, le contrôle TypeScript strict,
les tests négatifs de types, la compilation puis les tests Node hors réseau.
Ce lint contrôle les frontières du noyau et les marqueurs de fusion ; il ne
prétend pas remplacer un formateur ou un linter de l'application complète.

## Contrats

- Angles internes en radians, hauteurs ellipsoïdales en mètres.
- WGS84/ECEF en double précision ; aucune coordonnée globale en Float32.
- ENU = Est/Nord/Haut ; local Three = Est/Haut/Sud, repère droit.
- Matrices immuables 3×3 **row-major**. Ne pas les transmettre à une API
  column-major sans adapter son contrat. Voir ADR-001 pour ce choix de stockage.
- Un point est transformé par rotation et translation ; une vitesse seulement
  par rotation. Le recentrage du runtime et de la physique reste à implémenter.
- Mercator rejette les latitudes hors couverture au lieu de déplacer le joueur.
- Cellules 0–24 ; X périodique ; Y borné ; fractions internes conservées.
- Les IDs actuels décrivent uniquement le schéma Mercator. Le cube-sphere n'est
  ni implémenté ni implicitement couvert par ces tests.

## Domaine de l'inverse ECEF

Le domaine validé est une hauteur ellipsoïdale de -12 000 à 100 000 000 mètres.
Le centre de la Terre et les points profondément internes sont refusés.
Sur l'axe polaire, la longitude de sortie vaut 0 par convention ; une latitude
polaire n'a pas de longitude physique unique. Une non-convergence lève une erreur.

## Références indépendantes

`tests/fixtures/proj-wgs84.json` contient 32 références ECEF, 6 références ENU et
14 déplacements géodésiques d'un mètre générés par pyproj 3.7.2 / PROJ 9.5.1.
Les tests normaux n'ont besoin ni de Python, ni de réseau, ni de token Mapbox.
Le script `scripts/generate-reference-fixtures.py` permet de les régénérer ; ce
n'est pas une étape du build et les nouvelles valeurs doivent être revues.

Sources mathématiques :
- https://proj.org/en/stable/operations/conversions/cart.html
- https://proj.org/en/stable/operations/conversions/topocentric.html

## Non livré dans cette tranche

Pas de nouvelle scène de jeu, de terrain V2, de DEM, de conversion de géoïde,
de serveur, de LOD, de physique, de streaming, ni de benchmark GPU. Les tests de
bornes de cellules ne sont pas des tests de raccord de meshes : ceux-ci viendront
avec le générateur de terrain.
