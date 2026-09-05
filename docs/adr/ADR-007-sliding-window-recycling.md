# ADR-007 — fenêtre 3×3, préchargement directionnel, recyclage chaud

## Décision

Appliquer le plan validé avec Amir sans remplacer le noyau, le scheduler, les
workers ni les fournisseurs V2. Le mode 3×3 devient le choix initial du sélecteur ;
le streaming reste volontaire. Les modes métriques de l'ADR-006 et leurs tests
restent inchangés. Aucun quadtree ni nouveau moteur physique dans cette tranche.

## Géographie

Soit `(x, y, L)` la cellule canonique du joueur et `n = 2^L`.
La fenêtre active est `{(wrap(x+i,n), y+j, L) | i,j ∈ {-1,0,1}}`, avec
`wrap(a,n) = ((a % n) + n) % n` et rejet des indices `y+j` hors `[0,n)`.
Le centre logique suit la cellule, pas l'origine flottante. ECEF Float64, mètres,
échelle du joueur et transformations rigides V2 sont inchangés.

La vitesse ECEF `(vx,vy,vz)` est projetée dans le plan tangent au joueur :

```text
east  = -sin(λ) vx + cos(λ) vy
south = sin(φ) cos(λ) vx + sin(φ) sin(λ) vy - cos(φ) vz
```

En dessous de 0,25 m/s horizontaux, ne pas précharger de bande directionnelle.
Sinon, sélectionner l'une des huit directions avec le seuil `tan(π/8)=√2-1`.
Les cellules de la fenêtre translatée d'un indice dans cette direction, absentes
du 3×3 actif, forment la bande préchargée : trois cellules ou cinq en diagonale.
La distance de tri est la borne de distance ECEF aux empreintes h=0 de l'ADR-006,
pas une distance Mercator supposée métrique. Le centre passe avant ses voisines,
elles-mêmes avant la bande. Ce préchargement borné n'est pas une garantie de SLA.

## Présentation et collisions

Le scheduler demande la nouvelle fenêtre dès le prochain recalcul (100 ms au
plus de temps de simulation du streamer). Une seule nouvelle cellule est intégrée
par frame. En mode fenêtre, les nouvelles cellules sont d'abord cachées, avec un
BVH conservé mais exclu des requêtes physiques.

La fenêtre visible précédente reste en place jusqu'à ce que toutes les cellules
actives demandées soient installées. Le changement de visibilité et l'activation
des colliders sont synchrones avant le pas joueur. Le contrôleur conserve son
garde-fou de support existant ; il ne doit pas marcher sur une surface cachée.
Les cellules préchargées/récemment quittées ne sont pas reconstruites au retour.
Le rebase transforme également les ressources cachées. Une réapparition réactive
le patch de départ avant de recréer la pose du joueur.

## Recyclage et propriété

`RecyclingIndex` ne détient que taille comptabilisée et récence. Les adapters
restent propriétaires des ressources. Une visite réactualise la récence ; la
simple consultation d'un candidat n'en fait pas une visite.

Protéger les cellules visibles, demandées (bande comprise) et épinglées. Au-delà
du budget, choisir la plus ancienne cellule non protégée, avec clé stable comme
départage. Au plus une éviction par appel de nettoyage ; des cellules quittant
ensemble la fenêtre peuvent dépasser temporairement le seuil souple de 12.
Les plafonds de 64 résidentes et 32 Mio de payloads sont contrôlés avant admission.
Si aucun candidat n'est évictable, attendre plutôt que supprimer un sol actif.

À l'éviction : retirer collider/mesh, disposer les ressources graphiques propres
à la cellule, transférer la propriété du packet vers le LRU CPU existant. Ce LRU
reste borné indépendamment. La persistance et les quotas fournisseur de l'ADR-006
ne changent pas. Le mot « chaud » garantit ici la conservation des objets, pas
une résidence physique GPU que le pilote ne pourrait jamais remettre en cause.

## Coût et validation

À l'admission, seuls les quatre voisins cardinaux du nouveau packet sont comparés :
les raccords entre anciennes cellules immuables ont déjà été validés. Les seuils
existants (1 mm et 0,001 de différence de normale) ne sont pas relâchés.
Les diagnostics d'ensemble sont regroupés, pas recalculés à chaque nouvelle cellule.
Le compteur BVH permet de distinguer une réactivation d'une reconstruction.

26 tests CPU ajoutés ; scénario navigateur avec touches réelles, retour sur les
mêmes UUID, rebases, éviction et fournisseur lent simulé. Les tests historiques
sont conservés. Résultats, SHA et limites sont consignés dans la PR de livraison.
Aucun test Mapbox live automatique pour cette tranche.

## Hors périmètre

Progression terrain/collider puis imagerie indépendante, BVH en worker, budget
GPU dur, LOD mixte, terrain distant, certification du datum, Safari et sessions
longues. Le 3×3 n'est pas un rayon métrique constant ni une promesse d'absence
universelle de chargements perceptibles. Les routes/bâtiments/arbres restent à venir.
