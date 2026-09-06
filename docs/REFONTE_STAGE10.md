# Étape 10 — surfaces routières et intégration au streaming

La V2 normale lance automatiquement le terrain, la marche et les routes. Les
cellules routières suivent la sélection, le préchargement, les racines visibles,
le recyclage et l'éviction du streamer existant. Le bouton « Analyser la zone
visible » reste un diagnostic optionnel : il ne conditionne plus les chaussées.
Le mode `?lab=manual` conserve les anciens parcours hors ligne et explicites.

Les routes et chemins au sol ont une largeur horizontale **estimée**, versionnée
par catégorie (et distinguée de la donnée source), des virages arrondis et des
surfaces de jonction sans rectangles superposés. Les trous d'un rond-point sont
conservés. Les ponts, tunnels, escaliers, structures inconnues et couches
explicitement hors sol restent différés : aucune chaussée factice sous un pont.

Les primitives sont construites avec contexte avant le découpage des cellules.
Leur couverture est partitionnée sur chaque triangle du terrain réellement
installé. Chaque morceau est interpolé sur ce triangle : pas de seconde source
d'altitude, de lissage indépendant, de décalage physique ou de nouveau collider.
Un biais de profondeur de rendu évite le z-fighting ; le test de profondeur reste
actif. Matériaux simples distincts pour asphalte, sol non revêtu et chemin pavé.
Pas encore de voies, marquages, bordures, dévers ni terrassement.

Un seul worker vectoriel est partagé avec le diagnostic, ainsi que son cache
source RAM et son quota. Une tâche de surface d'une cellule est en vol à la fois.
L'admission est étagée (mesh caché, compilation, upload, publication) et partage
le budget de démarrage de frame du streamer terrain. Les surfaces ne bloquent
jamais les collisions de sécurité. Un résultat d'un ancien monde ou d'une
ancienne instance de cellule ne peut pas être publié.

Budgets : 256 tentatives vectorielles par monde en exploration automatique,
32 par tâche au maximum ; le mode manuel seul conserve son plafond de 32.
Ce quota est **distinct** des 256 tentatives du streaming raster et n'est pas un
plafond de facturation du compte. L'authentification refusée, un quota épuisé ou
un 429 suspendent les nouvelles tâches de surface ; le sol valide reste présent.
Mapbox reste exclusivement en mémoire. Aucun token n'est inscrit dans le dépôt.

Payloads routiers résidents : 8 Mio maximum, également comptabilisés dans le
budget global de résidence du streamer ; paquet en préparation : 2 Mio maximum.
Le cache source reste plafonné à 16 Mio/16 tuiles. Les estimations ne mesurent
pas la mémoire totale JS ou VRAM du pilote. Le retour vers une cellule retenue
réutilise sa géométrie routière ; après éviction réelle, elle peut être régénérée.

Les résultats exécutés, les mesures et les limites de validation sont consignés
dans la PR, pas déduits de la seule présence des tests.

Voir [ADR-010](adr/ADR-010-road-surfaces.md) pour les formules et invariants.
