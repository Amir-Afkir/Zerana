# Étape 8 — exploration directe et chargement étagé

## Utilisation

Ouvrir `/Zerana/v2/` : le token public configuré par `VITE_MAPBOX_API_KEY` est
utilisé automatiquement. Avec un token valide, le relief/satellite Mapbox charge
au démarrage ; sans token, le terrain synthétique est choisi. Streaming 3×3 et
joueur s'activent après la préparation du départ, sans bouton « Marcher ».

ZQSD/WASD/flèches pour marcher, Maj pour courir, Espace pour sauter. Échap met
en pause ; une nouvelle touche de déplacement ou un clic dans la vue reprend.
La saisie dans les champs ne fait pas bouger le joueur. Le blur libère les touches.

Les réglages et diagnostics sont repliés. Ils conservent les outils précédents.
Le mode `?lab=manual` ouvre ces outils, démarre hors ligne sans streaming, et
permet les anciennes expériences contrôlées. `?source=synthetic&level=19`
ouvre directement un monde de test automatique sans appels Mapbox.

Les crédits du fournisseur sont dédoublonnés et regroupés dans une bande lisible.
Le logo, Mapbox, OSM, Maxar et le lien de correction ne sont pas supprimés.
Le HTML fournisseur est filtré ; les autres crédits ne sont pas effacés.

## Réduction des à-coups

- Chaque nouvelle cellule apporte un BVH construit dans un worker, en tableaux
  transférables ; validation coopérative avant adoption par la physique.
- Étapes séparées : vérifier → créer le mesh caché → compiler les shaders →
  précharger les buffers GPU → publier les collisions et la cellule.
- Le relief Mapbox arrive avant l'imagerie. Une image lente ne bloque plus
  l'admission d'un terrain valide. Une seule tâche d'imagerie à basse priorité
  utilise le même pool et le même quota réseau que le terrain.
- Le recyclage réutilise les ressources. Les wireframes de diagnostic ne sont
  plus construits quand ils ne sont pas affichés.
- Les collisions, l'échelle métrique, l'ECEF et les seuils de raccord ne changent pas.

## Budgets et validation

Les plafonds de résidence, LRU et workers sont conservés. La taille des BVH est
comptabilisée dans les paquets ; l'imagerie réserve aussi sa place dans la file.
Le namespace IndexedDB change pour ne pas réutiliser un ancien format sans BVH.
Mapbox reste uniquement en mémoire, avec au plus 256 tentatives supplémentaires
par activation. Le démarrage automatique a été demandé par le propriétaire ;
ce plafond n'est pas une limite de facturation globale du compte.

La clé reste dans la configuration Actions existante, pas dans le dépôt. Le
contrôle live vérifie son empreinte, sans écrire sa valeur dans les rapports.
Les restrictions d'URL/scopes du compte ne sont pas modifiées ici.

Les tests historiques utilisent explicitement le mode manuel ; un nouveau
parcours teste le vrai démarrage automatique, les touches, les crédits uniques,
les BVH hors fil principal et l'imagerie retardée. Un aller-retour synthétique
chronométré de 120 secondes relève résidence et heap après GC. Ce dernier test
ne constitue ni un benchmark de fluidité ni une preuve sur plusieurs heures.

Un seul contrôle live peut être activé par le marqueur de livraison
`[verify-stream-live]` ; maximum 96 requêtes externes, SHA publié et token vérifiés.
Les résultats réellement obtenus sont consignés dans la PR, pas déduits de la
simple présence du test.

## Limites

La construction initiale du patch statique conserve son chemin précédent. Les
commandes WebGL restent non préemptibles ; 4 ms est un budget de démarrage souple,
pas une garantie. Chaque étape et le total CPU d'admission sont mesurés séparément.
La résolution physique reste celle du terrain ; pas de LOD mixte, routes,
bâtiments, végétation ou nouvel avatar. Le datum Mapbox reste approximatif.

Décision et preuves de contrat : [ADR-008](adr/ADR-008-staged-admission-and-direct-exploration.md).
