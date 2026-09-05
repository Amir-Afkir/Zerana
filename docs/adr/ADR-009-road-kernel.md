# ADR-009 — Noyau des axes routiers et diagnostic par cellule

Statut : implémentation étape 9, vérifications exécutées consignées dans la PR.
Base : `7596bea3890225c3ab499c8d24501f6b19c84be7`.

## Décision et portée

Ajouter un noyau CPU indépendant du renderer et du provider, un adaptateur
Mapbox Streets v8, et un diagnostic volontaire sur les cellules visibles.
Ne pas ajouter dans cette PR les chaussées, largeurs estimées, carrefours maillés,
colliders routiers, ponts/tunnels 3D, itinéraires ou un second streamer.
La V1, le Geo Kernel, le terrain, son échelle et la référence normative restent inchangés.

## Rectifications nécessaires du plan de discussion

- MVT est une représentation cartographique, pas une topologie OSM complète.
  Un croisement géométrique n'est pas une intersection navigable prouvée.
- L'ID MVT peut être nul, fusionné ou instable. Un hash de géométrie ne recrée
  pas l'identité mondiale d'une route découpée ou simplifiée différemment.
  Notre clé identifie un **segment normalisé dans une version/zoom source**.
- Le calcul exact empêche nos propres erreurs de clipping ; il ne répare pas
  les arrondis/simplifications divergents déjà présents entre tuiles source.
  Les ports non raccordés restent observables, sans soudure à tolérance cachée.
- Un raccord numérique millimétrique n'est pas une précision géographique
  millimétrique. L'overzoom n'ajoute aucune information à la source.

## Chaîne

TileJSON → MVT bornée → lignes/tags normalisés → propriétaires des noyaux source
→ graphe cartographique → clipping exact WorldCell → diagnostic sur triangles.

Les coordonnées MVT `(qx,qy)` sont conservées avec l'extent réel `E` et le zoom `z` :

```
u = (tileX * E + qx) / (E * 2^z)
v = (tileY * E + qy) / (E * 2^z)
```

`u,v` sont sans dimension. Les numérateurs/dénominateurs BigInt sont réduits par
PGCD. E peut différer entre tuiles ; aucune hypothèse silencieuse E=4096.
Les coordonnées buffer restent non enveloppées pendant le clipping. La clé
normalise u modulo 1 ; v ne boucle jamais. Les conversions vers WGS84/ECEF
utilisent les fonctions géographiques existantes.

Pour un segment `P(t)=A+t(B-A)`, `t` appartient à `[0,1]`. Le clipping calcule
l'intersection des intervalles d'entrée/sortie des quatre demi-plans, en fractions
exactes. Les contacts ponctuels sont omis. Une ligne entièrement sur le bord est
appartient à la cellule est ; sur le bord sud à la cellule sud, sauf limite extérieure
sud Mercator. Les points de traversée sont conservés dans les deux fragments.

Chaque tuile source possède son noyau demi-ouvert. Son buffer ne génère aucune
surface supplémentaire ; le segment original reste comme contexte. Le halo du
diagnostic est une couronne de tuiles source, **pas le futur halo métrique d'extrusion**.
La requête échoue si cette couronne dépasse 16 tuiles.

## Identités, graphe et cas non résolus

La clé de segment contient provider, version déclarée, zoom, attributs normalisés
et extrémités exactes. Le sens est canonisé uniquement pour les voies bidirectionnelles.
Les doublons strictement identiques sont supprimés ; les recouvrements partiels ou
les simplifications différentes ne sont pas prétendus résolus.

Les nœuds joignent uniquement des extrémités/vertices exactement communs, avec
structure et layer connus égaux. Les strata inconnues restent isolées. Même les
jonctions obtenues portent `cartographic-not-routable`. Aucun X géométrique sans
vertex source commun n'est transformé en carrefour. `layer` n'est jamais une altitude.

Chaque tuile conserve son SHA-256. Deux contenus différents déclarés pour la même
tuile dans un lot sont refusés. L'ensemble des SHA documente le lot observé, sans
prétendre à un snapshot transactionnel mondial du service Mapbox.

Largeur, droits d'accès détaillés et altitude routière ne sont pas inventés.
Les ponts, tunnels, escaliers et structures inconnues sont conservés dans les données
mais exclus du dessin au sol. Rails/ferries/aériennes ne deviennent pas des routes.

## Diagnostic et surface

Le diagnostic ne construit pas une chaussée. Il subdivise les axes à toutes les
arêtes de la grille triangulée du terrain : lignes `x entier`, `y entier`,
`x+y entier` en coordonnées de grille. Chaque petit segment est projeté par
interpolation barycentrique dans le triangle réellement rendu. Il n'interroge pas
un deuxième DEM et n'ajoute aucun offset vertical ni collider.

Les lignes sont un overlay de debug sans test de profondeur, explicitement non
physique. Les buffers Float32 restent dans l'ancrage existant de la cellule ;
rebase, visibilité et suppression du parent les concernent sans régénération.
L'overlay peut être masqué/réactivé. Une nouvelle analyse est un instantané manuel,
pas encore le chargement automatique de toutes les routes du monde.

## Ressources et transport

Un worker vectoriel paresseux ; aucun appel routier à l'ouverture de la page.
Réutilisation des dépendances verrouillées existantes `@mapbox/vector-tile`/`pbf`.
L'adaptateur borne les commandes géométriques avant expansion via l'offset paresseux
interne de la version verrouillée ; des tests le comparent à `loadGeometry()`.
Une évolution de cette dépendance exige de refaire ces tests.

32 tentatives réseau routières maximum par monde du laboratoire, compteur partagé
entre les analyses du même monde ; ce compteur est **distinct** des 256 tentatives
raster du streamer. Pas de retry automatique, pas de reset silencieux sur erreur.
Une interruption sans comptage fiable conserve sa réservation. La reconstruction
explicite d'un monde crée un nouveau budget : ce n'est pas un plafond de facturation.
URLs Mapbox fixes ; les templates de TileJSON ne sont pas exécutés.

4 Mio maximum par réponse ; 16 tuiles ; 12 000 features, 120 000 points et
60 000 arêtes maximum par lot ; 30 000 fragments, 60 000 segments de diagnostic,
neuf cellules au plus. Cache décodé LRU 16 Mio/16 entrées ; lot décodé 32 Mio.
Ce sont des plafonds de structures/payloads, pas une mesure totale du heap/VRAM.
Pas de persistance Mapbox, de token dans le dépôt, ni de requête dans les rapports.
Un résultat portant une ancienne révision ou un ancien objet terrain ne peut pas
se rattacher au monde reconstruit. Une erreur de routes ne retire jamais le terrain.

## Validation et livraison

Tests exacts : quatre cellules, demi-ouverture, anticorruption source, sens unique,
T/X/rond-point, strata, défaut de raccord volontaire, extents différents, anti-méridien,
200 rebases et projection des axes sur la surface triangulée.
Tests adaptateur : protobuf réel, IDs arbitraires, géométries non linéaires, commandes
malformées, budgets avant allocation, TileJSON, erreurs réseau, annulation et cache.
Navigateur : worker, ressources, trois rebases, cache source, terrain conservé après
erreur, résultat retardé après changement de monde, et nettoyage.

La CI conserve toutes les régressions V2 et le build V1. La livraison vérifie le
SHA servi et le parcours sur Pages. Un seul test live peut être activé avec
`[verify-road-live]`, maximum 48 appels Mapbox au total (terrain + routes), sans
publication de la clé. Les résultats d'exécution priment sur cette intention.

## Sources vérifiées

- [Mapbox Streets v8](https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/) : IDs, road, structure, layer, oneway, géométries et données manquantes.
- [Spécification MVT](https://mapbox.github.io/vector-tile-spec/) : grille entière, coordonnées, extent, propriétés et clipping hors du contrat de format.
- [Vector Tiles API](https://docs.mapbox.com/api/maps/vector-tiles/) : endpoints, formats, erreurs et tarification par requête.
- [TileJSON](https://docs.mapbox.com/help/glossary/tilejson/) : niveaux disponibles et métadonnées.
- `docs/architecture/ZERANA_WORLD_ENGINE.md`, sections 4–8 et Milestone 6 : unités, ancrage local, provider ≠ WorldCell, clipping et tests.

## Suite

PR suivante : largeur avec provenance, rubans métriques, jonctions et vrai rendu.
Ensuite : routier multicouche branché au préchargement/recyclage automatique et
budgets globaux communs. Pas de promesse de réseau routier mondial parfait à ce stade.
