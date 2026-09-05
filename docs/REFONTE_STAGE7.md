# Étape 7 — fenêtre glissante et recyclage

## Essayer

Dans `/Zerana/v2/`, générer un terrain synthétique en 32 subdivisions.
Dans **Monde continu**, garder **3×3 + préchargement + recyclage**, activer le
streaming puis marcher. Niveau 17 pour l'usage normal ; niveau 21 pour observer
rapidement plusieurs transitions. Faire demi-tour pour voir le compteur de réutilisation.
Les anciens modes à rayons métriques restent disponibles pour comparaison.

## Fonctionnement

- La cellule du joueur détermine une fenêtre logique 3×3, sans modifier son ECEF.
- Une bande supplémentaire est demandée devant la vitesse du joueur : trois
  cellules en direction cardinale, cinq en diagonale. Pas de bande au repos.
- La fenêtre précédente reste visible et collidable tant que la nouvelle n'est
  pas entièrement prête. Une cellule cachée ne peut pas servir de sol invisible.
- Les cellules quittées gardent leurs meshes, matériaux et BVH en recyclage.
  Leur réactivation ne demande ni réseau, ni génération, ni reconstruction de BVH.
- Le recyclage conserve au plus 12 cellules non protégées après éviction progressive.
  Les plus anciennement utilisées passent ensuite dans le cache CPU existant.
- Le départ reste épinglé et est réactivé avant une réapparition.

## Budgets conservés ou ajoutés

64 cellules résidentes au plus, départ et préchargement compris ; 32 Mio de
**payloads comptabilisés** en mode fenêtre. Ce compteur n'est pas le heap total ni
la mémoire GPU. Cache CPU 16 Mio, file prête/réservations 4 Mio, une intégration
par frame. Les 12 cellules recyclées sont un sous-ensemble des résidentes.
Mapbox : consentement séparé, 256 tentatives supplémentaires par activation,
aucune persistance de tuiles et altitude toujours `preview-only`.

## Vérifications

`npm --prefix v2 run check` conserve les 245 tests précédents et ajoute 26 tests.
Le scénario `sliding_window_smoke.py` vérifie le clavier, les demi-tours, l'identité
des meshes et le compteur de constructions BVH, les rebases, l'éviction, la
réapparition et le maintien de l'ancien terrain sous latence fournisseur simulée.
Il est exécuté avant/après déploiement et vérifie le SHA public attendu.
La PR consigne les exécutions effectivement réussies : la présence d'un test
ne vaut pas résultat positif.

## Limites

Cette tranche implémente **fenêtre + préchargement + recyclage**, pas tout le
Milestone 5. Terrain et imagerie Mapbox sont encore livrés ensemble ; leur
progression séparée reste à faire. Le BVH d'une nouvelle cellule est encore
construit sur le fil principal ; la réutilisation évite ce coût, sans le supprimer
pour une cellule inconnue. Une géométrie préchargée mais jamais dessinée peut
encore nécessiter un premier upload GPU.

Le 3×3 couvre une distance réelle variable avec la latitude et le niveau. Il
n'est ni un rayon constant, ni une garantie de délai réseau ou de chargement
invisible : un bord peut rester visible en vue éloignée, et le joueur peut être
retenu si le réseau est trop lent. Aux limites Mercator, la fenêtre est tronquée,
sans téléportation ni extension polaire inventée. Streaming Mapbox live, sessions
longues, FPS matériel, progression multicouche et LOD restent à valider.

Décision : [ADR-007](adr/ADR-007-sliding-window-recycling.md).
