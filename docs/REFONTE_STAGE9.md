# Étape 9 — Noyau routier et axes de diagnostic

Dans la préversion, ouvre **Outils du laboratoire → Routes — diagnostic →
Analyser la zone visible**. Le diagnostic reste volontaire et n'alourdit pas
le chargement initial du jeu. La marche et le streaming terrain restent automatiques.

En monde synthétique, les axes sont des fixtures fictives. En mode Mapbox, la clé
publique du site est utilisée : aucune ressaisie. Le diagnostic charge Streets v8
et montre routes en cyan, chemins en jaune. Les crédits fournisseur restent visibles.
Les axes sont sur les triangles du terrain, sans collider routier ou altitude inventée.

La fenêtre analysée est un instantané de neuf cellules au plus. Il faut relancer
l'analyse après un déplacement hors de cette zone. Les lignes déjà attachées suivent
les ancrages, le masquage et le recyclage de leurs cellules ; une cellule évincée
libère ses lignes. Le streaming routier automatique arrive dans une tranche ultérieure.

Le compteur autorise 32 tentatives réseau routières par monde, séparées du budget
raster. Les analyses répétées réutilisent les tuiles décodées encore en mémoire.
Pas de persistance, pas de diffusion de la clé dans les diagnostics. Si le fournisseur
échoue ou que le lot dépasse les plafonds, le terrain déjà valide est conservé.

Le noyau distingue les raccords exacts des ports source non raccordés. Ce n'est
pas encore un graphe de navigation : géométrie cartographique, jonctions candidates,
largeurs inconnues. Ponts, tunnels et escaliers restent en données, pas en faux tracés
au sol. La précision numérique des raccords ne certifie pas la précision de Mapbox.

## Vérifications

- `npm --prefix v2 run check` : régressions précédentes et 35 tests de noyau ajoutés.
- `node v2/scripts/test-road-adapters.mjs` : 16 tests MVT/provider bornés.
- `python v2/tests/browser/roads_smoke.py` : navigateur avec fixtures MVT binaires.
- `roads_live.py` : test de livraison explicite, borné, SHA public attendu.

Résultats effectifs, commit publié et captures : consulter la PR de l'étape 9.
Le nombre de fichiers ou la présence d'un test ne vaut pas preuve de réussite.

Décisions, formules et limites : [ADR-009](adr/ADR-009-road-kernel.md).
