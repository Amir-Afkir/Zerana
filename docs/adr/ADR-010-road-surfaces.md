# ADR-010 — surfaces routières conformes au terrain, couche de streaming

Statut : implémentation proposée, validation de livraison dans la PR.
Base : `bd8152f91c1166b07181d131afd44668e487db75`. Périmètre : PR10,
largeur / rubans / virages / jonctions ET chargement automatique demandé.
V1, Geo Kernel, colliders, origine flottante et référence normative inchangés.

## Décisions

1. Le graphe rationnel ADR-009 reste canonique et cartographique, non routable.
   Ses coordonnées, sommets, attributs et identités ne sont jamais corrigés par
   le renderer. Une largeur absente reste absente dans les données source.
2. Une politique visuelle `road-surface-style-v1` estime les largeurs en mètres
   horizontaux. Elle n'invente ni des mesures observées ni un nombre de voies.
   Les catégories inconnues/construction/escaliers sont différées. `structure`
   doit annoncer `ground` ou `ford`. Un layer explicitement non nul est différé ;
   un layer absent n'empêche pas une chaussée explicitement au sol, sans devenir
   pour autant une strate topologique connue dans le graphe.
3. Primitives convexes en coordonnées Mercator normalisées AVANT découpage :
   rubans subdivisés, joints arrondis aux sommets communs, bouts ronds aux
   extrémités cartographiques hors coupure source. Pas de cap à un port source
   non raccordé, pas de cap aux frontières des WorldCells. Aucun miter infini.
4. Les intersections sont une union surfacique de corridors au sol, pas une
   reconstitution de voies de circulation. Une priorité matériau stable tranche
   les recouvrements sans modifier les connexions du graphe.
5. On partitionne les triangles du terrain par ces primitives. La partition
   fournit des polygones convexes disjoints, triangulés en éventail. Les trous
   non couverts restent du terrain : aucun remplissage arbitraire de rond-point.
6. Le renderer reçoit des buffers CPU et utilise exclusivement les racines des
   cellules. La surface est coplanaire au terrain ; un `polygonOffset` de rendu
   ne change aucune hauteur. Pas de second collider ni de datum supplémentaire.
7. Le RoadSurfaceLayer n'est pas un second streamer. Il consomme `plan.wanted`
   et `loaded`, partage le worker vectoriel avec le diagnostic, annule les tâches
   sans intérêt, conserve les ressources sur les cellules retenues, et les libère
   avec leur propriétaire. Le terrain/collider garde la priorité.

## Modèle métrique

u,v : coordonnées Web Mercator normalisées ; v croît vers le sud. Les calculs
suivants concernent le WGS84 h=0 (largeur horizontale), pas la longueur mesurée
sur un talus incliné. Pour latitude φ, excentricité e et demi-grand axe a :

```
q = 1 − e² sin²φ
N = a / sqrt(q)                 [m]
M = a (1 − e²) / q^(3/2)        [m]
E = 2π N cosφ                  [m / unité u]
S = 2π M cosφ                  [m / unité v]
t = normalize([E Δu, S Δv])
l = [−t_y, t_x]
offset(p,r) = [u + r l_x/E, v + r l_y/S]
```

Les rubans évaluent ce Jacobien à chaque extrémité ; les segments de construction
sont de 32 m au plus. Rayon maximum 5,25 m. Domaine initial : WorldCell niveau
15–24, couverture Mercator existante. C'est une approximation différentielle
locale explicitement testée, pas un solveur de conception routière géodésique.
Le halo de contexte reste une couronne de tuiles source ADR-009, suffisante pour
ces rayons avec Streets source z16 dans la couverture initiale. Les futurs
fournisseurs à un niveau supérieur exigent une planification métrique du halo.

Un arc de rayon r est polygonisé avec erreur radiale cible ε = 0,025 m :

```
n >= π / acos(1 − ε/r)
```

Le résultat est borné à 12–40 côtés. ε est une tolérance de forme, pas une erreur
sur les mesures du fournisseur. Le centreline source n'est pas lissé.

## Drape sur le terrain commis

La grille terrain fournit les coordonnées locales exactes `x,y` en unités de
subdivision. Pour dx,dy dans un carré et indices a,b,c,d de son terrain :

```
dx+dy <= 1 : P = (1−dx−dy) A + dy C + dx B
sinon     : P = (1−dy) B + (1−dx) C + (dx+dy−1) D
```

On coupe CHAQUE primitive par CHAQUE triangle concerné avant d'appliquer cette
formule aux sommets de sortie. Un seul segment ou triangle ne traverse donc pas
une crête par un raccourci droit. Positions et normales utilisent les buffers
commis, y compris leur arrondi Float32. Normales interpolées puis normalisées.
Les UV restent géographiques, `[x/N, 1−y/N]` ; pas de texture répétée directionnelle
ou de marquage longitudinal promis dans cette première surface.

Pour une arête de clip orientée A→B : `d(P)=cross(B−A,P−A)`. Deux points P,Q de
signes opposés se coupent en `P + d(P)/(d(P)−d(Q)) (Q−P)`. Le même point est fourni
aux deux demi-plans complémentaires. En retirant successivement une primitive
convexe de la portion non encore couverte, chaque surface n'est émise qu'une fois.
Tolérance de nettoyage : 1e−12 unités de grille ; pas de snapping géographique.
Les cas limites sont testés par conservation d'aire et intersection des triangles.

## Budgets et cycle de vie

Maximum 4096 primitives locales ; 24 000 sommets de sortie ; 192 morceaux par
triangle terrain ; 150 000 opérations de partition ; paquet <= 2 Mio. Dépassement :
erreur explicite, pas d'approximation silencieuse ni perte du terrain.
Résidence routière <= 8 Mio, comptée aussi dans le RecyclingIndex terrain.
Une seule tâche/paquet en attente ; source LRU 16 Mio/16 tuiles. La pression
mémoire évince d'abord des surfaces retenues non visibles ou une cellule éligible.
Un budget impossible est signalé, sans boucler sur une allocation impossible.

Chaque résultat est lié à l'époque du monde, à l'objet terrain et à l'instance
de racine ; identités identiques ne suffisent pas après remplacement. Le retour
chaud garde les UUID. Le rebase transforme la racine, jamais les vertices.
Un arrêt ou un onglet caché n'autorise aucun nouveau téléchargement de surfaces.
Les résultats périmés rendent leur quota seulement avec un décompte confirmé.

## Contrôles de livraison

Tests CPU : métrique, convexité, couverture disjointe, T/X/angle aigu, trou de
rond-point, crête, quatre cellules, antiméridien, ordre d'arrivée, données vides,
formats invalides et structures différées. Régressions antérieures conservées.
Tests navigateur : exploration sans bouton, vrai changement de cellules,
demi-tour/UUID, rebase, provider lent et refusé, annulation, budgets et disposal.
Validation Mapbox live séparée et plafonnée, sans publier de token.

## Limites

Surfaces visuelles de première génération ; largeur et matériaux contextuels
estimés. Pas de profil longitudinal lissé, dévers, terrassement, ouvrages,
marquages, trottoirs, trafic ou routage. Pas d'invention de joint entre deux
endpoints fournisseur discordants. Des largeurs estimées peuvent masquer un
terre-plein non représenté par les données. La précision numérique n'est pas
celle de l'image satellite ni un relevé cadastral. Les uploads GPU ne sont pas
préemptibles : budget de démarrage 4 ms partagé, pas une garantie de 60 FPS.

Références vérifiées le 6 septembre 2026 :
- Mapbox Streets v8 : https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/
- Three.js Material (polygonOffset) : https://threejs.org/docs/pages/Material.html
- BufferGeometry : https://threejs.org/docs/pages/BufferGeometry.html
- ADR-009 et ZERANA_WORLD_ENGINE.md du dépôt, conservés.
