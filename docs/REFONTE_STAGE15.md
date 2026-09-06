# Étape 15 — Surfaces d’eau et streaming

Base : `ed73f2e383d48ff4015d3306e3875d11b8071ab6` (PR14).
Cette tranche ajoute **des surfaces 3D visibles**, activées automatiquement dans
le mode routier normal. Ce n’est ni un solveur hydraulique mondial ni une
nouvelle surface physique de déplacement. La livraison se constate dans la PR
après CI, publication et vérification de la révision effectivement servie.

## Parcours et périmètre

`/Zerana/v2/?source=mapbox&level=19` : eau automatique, sans analyse manuelle.
La case « Afficher l’eau » dans les outils masque/réaffiche les ressources déjà
préparées. `water=0` désactive la préparation pour cette session. Le mode
synthétique permet de tester sans appels Mapbox. Les contours PR14 restent
facultatifs et distincts des surfaces.

Polygones `water` avec leurs îles/trous, cours d’eau non intermittents en rubans
métriques, matériau opaque animé à reflets de ciel approximatifs. Ni capture de
reflet de scène, ni vagues géométriques, ni nage, flottabilité ou profondeur.
Le terrain et ses collisions restent inchangés. **Un joueur ne marche pas sur
un collider d’eau** : la physique est toujours celle du terrain sous-jacent.

Le réglage conseillé est L19/32 subdivisions, source Streets Z16 actuelle.
Les niveaux L15–L21 sont acceptés, avec source au plus L16 dans cette version.
Un zoom supérieur ne crée pas davantage de précision dans les données source.
Le mode expérimental `engineering=1` est inchangé et ne reçoit pas cette couche.
Son test Mapbox réel précédent est en échec ; cette PR ne le requalifie pas.

## Réemploi de PR14

Le worker routier reçoit le même snapshot MVT que les routes et le diagnostic.
Il n’y a **aucun nouveau téléchargement vectoriel spécifique à l’eau**, ni
nouveau scheduler ou worker. Une réponse produit trois paquets indépendants :
route, diagnostic, eau. L’échec d’une surface secondaire ne doit pas retirer le
terrain sûr ni invalider une autre couche valide.

Le DEM nécessaire au niveau d’eau est plus large que la WorldCell. Le même
worker vectoriel charge donc un contexte de relief fixe, sans imagerie, avec un
cache PNG mémoire propre et borné. **Ces requêtes de relief sont supplémentaires**
par rapport au terrain déjà présent ; le cache inter-workers n’est pas partagé.
Elles sont imputées avant chaque tentative au même quota routes/eau, plafonné à
256 par monde (diagnostic compris), et au grant de 32 par job. Les requêtes du
streamer terrain ont leur budget préexistant distinct. Ces quotas ne plafonnent
pas la facturation totale d’un compte ou de plusieurs sessions.

## Géométrie

Les anneaux canoniques PR14 conservent leurs fractions Mercator exactes. Le
triangulateur Earcut déjà verrouillé dans les dépendances ne choisit que les
indices ; les sommets sont repris dans les coordonnées sources originales.
Contrôles : aire couverte, indices, centroïdes hors des trous, budgets. Ce n’est
pas une certification complète des géométries cartographiques auto-intersectées.
Un cas non résolu refuse la couche plutôt que de combler une île arbitrairement.

La surface est ensuite intersectée, en arithmétique rationnelle, avec le cœur de
la tuile source, les triangles de la grille hydrographique et la WorldCell.
La partition complémentaire produit une union sans double recouvrement : les
polygones d’eau passent avant les rubans. Les coupures artificielles ne créent
pas de berges. Une séparation par axe évite de fragmenter les zones disjointes.

Largeurs estimées : rivière linéaire 6 m, canal 4 m, ruisseau 1,5 m, drain 1 m,
fossé 0,8 m. La vraie largeur d’une rivière déjà polygonale vient de son polygone.
Raccords arrondis à 12 côtés. Les décalages transversaux utilisent les facteurs
métriques de l’ellipsoïde, pas les degrés comme mètres :

```
N = a / sqrt(1 - e² sin²φ)
M = a (1-e²) / (1 - e² sin²φ)^(3/2)
E = 2π N cosφ ; S = 2π M cosφ
(dx,dy) = (E Δu, S Δv)
(δu,δv) = (-dy/ℓ × w/(2E), dx/ℓ × w/(2S))
```

Les offsets sont quantifiés sur 2^40 subdivisions du monde, erreur inférieure
à 0,04 mm à l’équateur ; cela n’améliore pas la précision des tracés MVT.
Cours intermittents et catégories inconnues restent différés. Un `water` non
classifié ne devient pas automatiquement un lac, une mer ou une rivière.

## Niveaux partagés : méthode et limite essentielle

Une région de calcul est le cœur d’une tuile source, avec son contexte 3×3
complet. Les **adresses d’échantillonnage sont mondiales et fixes**, indépendantes
du joueur, de l’ordre d’arrivée et du niveau des cellules de rendu. Le profil
source reste lié aux digests du DEM et des MVT.

Pour le champ général : n = 16 subdivisions par tuile ; q = 2^z n. Au nœud
entier mondial (i,j), on évalue les mêmes 25 positions :

```
u = (2i + a) / (2q) ; v = (2j + b) / (2q), a,b ∈ {-2,-1,0,1,2}
H(i,j) = médiane inférieure des hauteurs des taps cartographiés comme eau
```

Si aucun tap n’est cartographié comme eau, on échantillonne le DEM au nœud.
Une tuile demandée mais absente/invalide n’est pas une tuile vide. En revanche,
une MVT valide sans couche `water` signifie simplement qu’elle ne décrit pas de
polygone d’eau. NaN/nodata ou datum incompatible ne sont jamais remplacés par
zéro dans ce solveur. Le fallback tout-eau documenté du fournisseur reste celui
de l’adaptateur Terrain-RGB, avec autorité preview, pas un zéro géodésique certifié.

Interpolation affine sur la diagonale mondiale fixe, pour x,y dans [0,1] :

```
x+y ≤ 1 : H = (1-x-y)Ha + xHb + yHc
x+y > 1 : H = (1-y)Hb + (1-x)Hc + (x+y-1)Hd
```

Deux régions partagent ainsi les mêmes valeurs nodales et arêtes. Un polygone
entièrement fermé à l’intérieur du cœur source et sans axe d’écoulement voisin
peut recevoir **un seul niveau estimé**, médiane des DEM aux centroïdes de ses
triangles, pondérée par leur aire projetée. Toutes les cellules concernées
réutilisent cette valeur. C’est une hypothèse de plan d’eau fermé, pas une
classification hydrographique certifiée.

**Adaptation explicite du plan initial :** faute d’identité de plan d’eau et de
sens d’écoulement dans les données disponibles, les grands plans d’eau ouverts,
les cours d’eau et la côte utilisent le champ continu estimé, non un profil
hydraulique résolu. Ils ne sont pas garantis horizontaux ou toujours descendants.
Les très grands lacs, les barrages/écluses, les transitions lac/rivière et un zéro
océanique géodésique demandent encore des contraintes hydrographiques communes.
Il serait faux de déclarer ces problèmes résolus par une simple médiane de DEM.

## Rendu, datum et physique

Chaque sommet suit WGS84 → ECEF Float64 → repère Three de sa cellule ; le GPU
reçoit les positions Float32 locales. Aucun changement d’échelle du joueur.
L’animation modifie seulement l’éclairage de la normale. Sa phase géographique
est partagée entre cellules ; aucun déplacement vertical périodique aux raccords.

Le niveau est en `UNRESOLVED_DATUM_PREVIEW` avec Mapbox, et garde la référence
synthétique lorsqu’elle est connue. Le paquet porte
`estimated-not-hydraulically-qualified`, `terrainModified=false`,
`collidersAdded=0`, `swimming=false`. Un **offset de rendu de 3 cm**, déclaré dans
le paquet, limite le z-fighting ; ce n’est ni une épaisseur d’eau ni une profondeur.
Le matériau ne force pas l’eau devant tout le terrain. Des occlusions au rivage
restent possibles si le DEM contredit le profil estimé. Pas de terrassement
hydraulique ou de bathymétrie inventés dans cette tranche.

Les routes/ouvrages ne sont ni abaissés ni transformés en ponts par cette couche.
Les ouvrages routiers déjà différés restent différés. La résolution physique des
croisements, les berges et une transition de baignade sont des étapes distinctes.

## Streaming et ressources

`paquet CPU → géométrie masquée → compilation shader → upload → publication`.
Chaque étape respecte le budget du streamer existant ; une étape GPU déjà lancée
n’est pas préemptible. Terrain puis routes restent prioritaires. Les ressources
sont rattachées à la même racine de cellule et suivent automatiquement visibilité,
rebase et recyclage. Un retour dans le recyclage réutilise les UUID : aucun
nouveau mesh, aucune requête de données pour ces cellules conservées.

Le readset compare les digests DEM et vectoriels à ceux des paquets d’eau et du
terrain résidents. Une arrivée ultérieure de terrain avec un DEM contradictoire
retire l’eau incompatible, pas le sol sous le joueur. Les réponses annulées ou
d’un ancien monde ne peuvent plus être admises. Une éviction dispose les
ressources Three et actualise le budget de recyclage commun.

Plafonds : 16 384 points/triangles source, 16 000 sommets et 20 000 triangles
par cellule, 150 000 partitions, 128 morceaux intermédiaires, 1 Mio/paquet,
4 Mio de payloads d’eau résidents. Caches du worker : quatre régions/16 Mio,
géométries 8 entrées/4 Mio, PNG 32 entrées/4 Mio. Le cache MVT partagé PR14
reste à 16 Mio/16 snapshots. Les comptes conservateurs de payloads ne sont pas
une mesure complète du heap, des allocations transitoires ou de la VRAM.

## Validation

Les tests précédents sont conservés. Nouvelles fixtures : découpe exacte,
trous et union, niveau fermé partagé, limites de tuiles et de cellules,
antiméridien, révisions incompatibles, datum, données invalides, largeur métrique,
absence de couche, cache et annulation. Vérification navigateur : surfaces
réellement visibles par comparaison des pixels du canvas avec/sans eau,
marche de 70 m et retour, mêmes géométries, trois rebases, visibilité, source
refusée isolée et changement de monde pendant une requête.

Le test live est explicitement activé, sans sauvegarde de tokens ni de données
Mapbox brutes. Quatre points fixes : Seine, lac Daumesnil, canal Saint-Martin,
Vieux-Port de Marseille ; **256 tentatives maximum au total**, relief/imagerie
compris, pas par point. Marche/retour et rebases sur la Seine. L’ancien test
routier Paris L17/90 m conserve son lieu et son plafond de 128. Ces parcours
ne constituent ni une couverture mondiale ni un benchmark du PC de l’utilisateur.

## Références primaires

- Mapbox Streets v8, `water` (plans d’eau fusionnés sans classification),
  `waterway` (axes et intermittence) :
  https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/
- Mapbox Terrain-RGB, résolution source et datums multiples :
  https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
- Earcut, limitations et contrôle d’aire : https://github.com/mapbox/earcut
- PR14 : `docs/REFONTE_STAGE14.md`. Geo Kernel et contrats de streaming V2
  existants : inchangés.
