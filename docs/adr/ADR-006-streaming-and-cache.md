# ADR-006 — Streaming métrique borné, workers et cache

Statut : implémentation expérimentale, première tranche du Milestone 5.
Base : `f567ee65ce5db8a68743823acbf2472e4cd3f99e`. Référence normative inchangée.

## 1. Périmètre et frontières

`v2/src/streaming` contient uniquement sélection, ordonnanceur et LRU déterministes.
Aucun DOM, réseau, horloge système ni Three.js n'entre dans ce domaine CPU.
`v2/demo/streaming` adapte navigateur, workers, IndexedDB et scène existante.
Le joueur logique ECEF reste unique ; ni sa taille, ni le Geo Kernel ne changent.
La V1, ses assets et lockfiles restent inchangés.

Cette livraison est un streaming incrémental **à LOD fixe par session**, pas encore
le pipeline multicouche complet des sections 11–12. Une cellule arrive avec terrain
et imagerie éventuelle ; le collider est installé dans la même transaction de frame.

## 2. Distance et sélection — toutes les longueurs en mètres

Soit S(lambda, phi) la conversion WGS84/ECEF avec hauteur ellipsoïdale h = 0.
On définit d(P,Q) = ||S(P) - S(Q)||₂ : corde ECEF entre empreintes au sol.
Ce n'est ni une distance Mercator, ni la distance géodésique le long du relief.
L'altitude n'agrandit pas le rayon sélectionné et ne change jamais l'échelle du joueur.
Les constantes a et e² viennent exclusivement du Geo Kernel.

Pour un rayon R <= 1 000 m :

```text
M_min = a(1 - e²)
C_max = a / sqrt(1 - e²)
delta_phi = 2 asin(R / (2 M_min)) + 1e-11 rad
phi_s = max(-phi_max, phi - delta_phi)
phi_n = min( phi_max, phi + delta_phi)
rho_p = N(phi) cos(phi)
rho_min = a cos(max(|phi_s|, |phi_n|))
delta_lambda = 2 asin(min(1, R / (2 sqrt(rho_p rho_min)))) + 1e-11 rad
phi_max = atan(sinh(pi))
```

Justification : à longitude identique, le vecteur tangent méridien vaut
M(phi)(-sin(phi), cos(phi)). La projection de sa primitive sur la tangente à la
latitude médiane majore inférieurement la corde par
2 M_min sin(|delta_phi|/2). Une différence de longitude augmente la distance :
le carré de la corde horizontale inclut 4 rho_p rho_q sin²(delta_lambda/2).
Comme rho_q >= rho_min dans la bande obtenue, les bornes angulaires ci-dessus
contiennent le disque défini. La marge angulaire est un arrondi sortant opérationnel,
pas une démonstration d'arithmétique par intervalles sur toute implémentation.

Les indices de toutes les cellules intersectant ce rectangle sont calculés par
projection canonique. X est ramené modulo 2^L ; Y est borné sans rebouclage.
La capacité est vérifiée avant l'allocation de la liste. Les pôles hors couverture
Mercator sont refusés ; aucune téléportation ou rotation nord/sud n'est inventée.

Pour filtrer chaque candidat, on borne son empreinte par une sphère ECEF :

```text
phi_c, lambda_c = centre obtenu par MercatorCellScheme.getCenter
q = latitude de l'intervalle [phi_s, phi_n] la plus proche de zéro
r_cell = C_max * (max(phi_n - phi_c, phi_c - phi_s)
                   + cos(q) * (lambda_e - lambda_w) / 2) + 1e-5 m
d_min = max(0, ||S(joueur) - S(centre)||₂ - r_cell)
```

Le centre inverse-Mercator n'est **pas** le milieu arithmétique des latitudes ;
les deux écarts sont donc calculés explicitement. Un chemin méridien puis parallèle
borne la corde de chaque point vers ce centre. d_min est une borne inférieure,
pas une distance exacte au polygone ; une sélection excédentaire est possible.

Réglage normal : sécurité 20 m, visibilité 120 m, rétention 200 m. Réglage de test :
4 / 20 / 35 m. L'union des disques courant et prédit est considérée. La prédiction
emploie S(geodetic(P_ecef + T * v_filtrée)), T = 2 s ; elle est abandonnée si elle
sort de la couverture. Filtre : alpha = 1 - exp(-dt/0,25 s).
La sélection est réévaluée environ toutes les 100 ms, indépendamment d'un rebase.

## 3. Priorités, révisions et annulation

Ordre lexicographique : cellule actuelle, sécurité, visibilité, prédiction,
distance métrique, clé stable (comparaison de code units, pas locale navigateur).
La zone de rétention ne déclenche pas à elle seule un nouveau téléchargement.

```text
QUEUED → GENERATING → CPU_READY → VISIBLE ↔ RETAINED → suppression
                         ↘ ERROR (retry borné ou terminal)
```

Chaque ticket possède une révision monotone **de session**, jamais remise à zéro
par suppression/recréation de cellule (protection anti-ABA). Un résultat dont la
clé/révision n'est plus attendue ne peut pas atteindre la scène. L'époque de session
rejette aussi tout résultat reçu après arrêt ou remplacement de la source.

Un slot worker reste occupé jusqu'au résultat, à l'accusé d'annulation ou à la
terminaison. Après annulation : délai maximal 750 ms avant terminaison forcée.
Watchdog d'un travail : 60 s. Les requêtes héritent du timeout fournisseur 12 s.
Le calcul CPU d'une cellule est synchrone dans son worker ; son résultat tardif
est rejeté plutôt que prétendument interrompu au milieu d'une instruction.

## 4. Budgets, ownership et sécurité du sol

| Ressource | Plafond de cette tranche |
|---|---:|
| Candidats de sélection | 512 |
| Cellules scène + colliders, spawn compris | 64 |
| Workers synthétiques / Mapbox | 2 / 1 |
| Requêtes simultanées Mapbox | 4 dans l'unique worker réseau |
| Paquet de cellule réservé | 1 Mio |
| Réservations + file CPU prête | 4 Mio |
| Cache CPU LRU | 16 Mio / 32 entrées |
| Cache RAW Mapbox en mémoire | 16 Mio / 128 entrées |
| Cache IndexedDB synthétique | 16 Mio / 64 entrées |
| Nouvelle cellule admise par frame | 1 |
| Début d'admission permis avant | 4 ms de travail streaming dans la frame |
| Tentatives de génération par cellule | 3 |

Les buffers sont transférés, puis possédés par le fil principal. Le collider en
possède une copie indépendante. Retirer un mesh appelle dispose sur ses ressources
propres, pas sur les matériaux partagés. Les BVH inchangés sont réutilisés.
Le calcul initial du BVH reste sur le fil principal : 4 ms est un seuil de démarrage,
**pas un plafond préemptif**. `maxCommitMs` rend les dépassements observables.
Ces compteurs ne prétendent pas mesurer exactement les objets JS, le heap total,
les copies de structured clone, la mémoire du pilote ou les allocations GPU.

Avant admission : format/autorité, clés de raccord, écart CPU <= 1 mm et différence
de normales <= 0,001. Des snapshots de tuiles différents sont permis uniquement
dans ce chemin explicite ; le diagnostic strict historique conserve son défaut.
L'imagerie conserve les conventions UV/gutter précédentes ; des mosaïques mises à
jour à des dates différentes peuvent néanmoins montrer des variations de couleur.

Avant la prochaine simulation, la mise à jour des colliders et des objets visibles
est synchrone. Les cellules de sécurité ne sont pas évincées. Le petit patch de
spawn (1/4/9 cellules) reste épinglé, même loin du joueur, pour la réapparition ;
il compte dans les 64 résidentes et constitue une exception bornée au rayon.

Fallback opérationnel : conserver le sol valide, arrêter le déplacement vers une
zone non couverte via les neuf sondes existantes. **Ce n'est pas encore un terrain
parent de secours à LOD différent** et les neuf sondes ne prouvent pas une couverture
pour un polygone arbitraire. Un fournisseur lent peut donc arrêter momentanément
la progression ; il ne doit pas provoquer une chute ou effacer le terrain validé.

## 5. Cache, source et facturation

Le cache CPU est propre à une configuration immuable. Le cache disque versionne
format, modèle, source, profil, référence verticale, cellule et subdivisions.
Les paquets synthétiques sont vérifiés par SHA-256 et schéma avant réutilisation.
L'écriture/éviction et les compteurs IndexedDB utilisent une transaction commune
aux workers/onglets. Refus d'ouverture, quota et corruption deviennent des misses.
Le cache est régénérable et supprimable par le bouton dédié.

Aucun token et aucune tuile Mapbox ne sont persistés. Une seule session worker
possède le cache RAW, évitant les doublons inter-workers ; la clé exclut le token.
Changer de session termine les workers. Les données Mapbox restent explicitement
`preview-only` avec leur provenance ; aucune conversion de datum n'est ajoutée.

Le streaming est désactivé à l'ouverture. Après un chargement Mapbox volontaire,
un **second consentement** autorise au plus 256 tentatives supplémentaires par
activation. Une réserve pessimiste est débitée avant le travail ; seules les
requêtes dont l'absence est connue sont remboursées. Une terminaison inconnue
conserve sa réserve. Le worker vérifie son propre grant avant chaque fetch.
Révoquer le consentement arrête la session. Une nouvelle activation explicite
constitue une nouvelle session, donc un nouveau budget potentiellement facturable.

## 6. Vérification et éléments encore ouverts

32 nouveaux tests CPU : sélection échantillonnée (dont hautes latitudes et
antiméridien), budgets, ownership, ABA, retry, worker simulé, colliders et raccords.
Six minutes **simulées**, >2,5 km, exercent le vrai contrôleur et le renouvellement
synchrone des cellules ; cela n'est pas un benchmark navigateur en temps réel.
5 000 fenêtres virtuelles vérifient le bornage du scheduler et du LRU.

Le parcours navigateur utilise de vrais workers, IndexedDB, clavier et WebGL,
avec des réponses Mapbox simulées. Il vérifie déplacement au-delà du patch initial,
éviction, rebase, stop, réutilisation disque, réseau lent et grant interne.
Les résultats effectifs du SHA sont consignés dans la PR #6 et ses artifacts.

Le DoD complet « longue durée / mémoire en plateau » reste à confirmer sur des
sessions navigateur prolongées et du GPU matériel. Cette tranche ne revendique
ni performance Safari, ni 60 FPS, ni correction du datum, ni carte polaire mondiale.
LOD mixte, terrain parent de secours et progression multicouche restent ouverts.
Les dépendances vulnérables préexistantes du build racine ne sont pas modifiées.

## Sources techniques

- Référence du projet : `../architecture/ZERANA_WORLD_ENGINE.md`, sections 11–12,
  Milestone 5. Elle reste normative et inchangée.
- Vite 6, Web Workers : https://v6.vite.dev/guide/features#web-workers
- MDN, Transferable objects : https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- Three.js, disposal : https://threejs.org/manual/en/how-to-dispose-of-objects.html
