# ADR-008 — admission étagée et exploration directe

## Décision

Conserver la fenêtre et le recyclage d'ADR-007. Ne pas introduire de moteur de
jobs générique ou de nouvelle bibliothèque. Séparer seulement le travail coûteux
qui précède l'admission d'une cellule, et masquer les outils du laboratoire par
défaut plutôt que de supprimer les diagnostics.

## Contrat du collider préparé

Le worker construit le même `TriangleIndex` que le chemin statique. Il exporte
les triangles dans des tableaux Float32, les identifiants source en Uint32, les
AABB en Float32 et les liens/arités en Int32. Ces triangles reprennent exactement
les coordonnées Float32 du packet : aucune quantification supplémentaire ni
conversion d'axe. Le BVH ne contient jamais l'origine flottante du renderer.

Pour chaque triangle préparé `t` d'identifiant source `i`, l'admission vérifie :

`prepared[9*t + 3*v + a] === positions[3*indices[3*i + v] + a]`

pour `v ∈ {0,1,2}`, `a ∈ {0,1,2}`. Les identifiants source forment une permutation
exhaustive des triangles. Toutes les valeurs sont finies et chaque face reste
non dégénérée. Chaque feuille couvre 1 à 8 triangles, sans chevauchement ni trou
dans les plages ; chaque boîte contient ses triangles ou celles de ses enfants.
Chaque enfant suit son parent dans le tableau et possède un seul parent : pas
de cycle, de nœud orphelin, de branche dupliquée ou de couverture supprimée.

Les contrôles sont divisés en lots bornés. Un index n'est adopté qu'après la
validation complète. Ses tableaux deviennent propriété exclusive de la physique ;
ils ne sont plus modifiés ou retransférés. Les vertices visuels restent indépendants.
Les transformations de requêtes demeurent celles d'ADR-005 :

`p_cell = R(world→cell) * p_world + t(world→cell)`.

Le rebase ne reconstruit ni triangles ni BVH. Le chemin statique initial continue
de construire synchroniquement ses colliders ; les compteurs distinguent ces
constructions des adoptions préparées.

## Admission et annulation

Une admission conserve le ticket courant du scheduler. À chaque frame, un ticket
périmé détruit son mesh caché sans modifier le sol actif. Le shader est préparé
avant un dessin hors écran d'une cellule, puis le collider et la résidence sont
publiés synchroniquement. La fenêtre visible attend toujours ses neuf terrains.

Un résultat de worker périmé, une fermeture de session ou une cellule évincée ne
peuvent pas installer tardivement une texture ou un collider. Les mêmes époques
et tickets anti-ABA qu'ADR-006 restent l'autorité.

## Imagerie progressive

Le provider accepte `terrain`, `imagery` ou `all`. `all` garde le laboratoire
statique historique. Le streamer demande d'abord `terrain`, puis une image pour
un terrain résident souhaité. Cette dernière ne change ni les vertices ni le
collider. Une tâche d'image au plus ; elle est annulée au profit du terrain si la
file en a besoin. Aucun cache persistant fournisseur n'est introduit.

La réservation image entre dans le budget existant :

`readyBytes + terrainReservedBytes + imageReservedBytes ≤ 4 Mio`.

Les tableaux du collider sont comptés dans les paquets et le recyclage. La mise
à jour de taille d'une cellule texturée ne rafraîchit pas artificiellement sa
récence LRU. Une seule étape d'upload de cellule ou d'image est commencée par frame.
Les opérations WebGL ne sont pas préemptibles : toutes leurs durées restent des
mesures, jamais des bornes universelles ou des promesses de 60 FPS.

## Interface et autorisation fournisseur

Parcours automatique demandé par le propriétaire : token public déjà configuré,
Mapbox par défaut quand il est disponible, preview-only explicite, puis streaming
et marche sans boutons supplémentaires. Aucun `sk.*` accepté. La clé n'est pas
ajoutée au code ou aux comptes rendus ; le contrôle de livraison compare son hash.
Le quota reste par activation, pas par compte ni par journée.

Le mode manuel documenté garde les anciens essais hors ligne. Les tests de ce
mode ne remplacent pas le nouveau test de démarrage automatique. Les attributions
restent visibles et dédoublonnées, conformément aux règles Mapbox et au TileJSON.

## Vérifications et limites

Tests d'équivalence des requêtes BVH à cinq positions géographiques ; corruption
de format, indices, positions, boîtes, arités et liens ; validation coopérative,
activation incrémentale, LRU et tickets périmés. Les tests navigateur utilisent
les entrées réelles et les workers réellement construits par Vite.

Les sondes de heap après GC sur 120 secondes sont un contrôle borné de rétention,
non un benchmark matériel ou une preuve sur plusieurs heures. Le contrôle Mapbox
réel est opt-in et plafonné à 96 appels, pas une preuve de couverture mondiale.
La vérité géographique, les formules du Geo Kernel et les seuils des raccords
restent inchangés. LOD, datum certifié et couches vectorielles restent hors tranche.

Références : documentation Mapbox « Attribution » et « How to use Mapbox securely » ;
documentation Three.js WebGLRenderer (`compileAsync`, `initTexture`).
