# Zerana V2 — état de l'étape raster

Base exacte : `7294c874fdbd5bc08e62f3bbbbe9198f5086ad68` (PR #2).
Branche : `feature/v2-raster-providers`.
Portée : décodage raster, référentiels verticaux, mosaïque inter-tuiles, imagerie,
adaptateur Mapbox et tests du laboratoire isolé.

Le jeu racine, les assets historiques, les lockfiles et le workflow de déploiement
Pages ne sont pas modifiés. Les PR #1/#2 ne sont pas fusionnées par cette étape.

Résultats disponibles avant publication : TypeScript strict et 32 nouveaux tests
raster réussis dans l'environnement de travail. L'exécution navigateur locale
n'a pas été validée (accès HTTP bloqué par la politique du navigateur disponible).
La CI GitHub doit donc confirmer la suite complète et les parcours navigateur
avant que cette PR sorte du brouillon. Le résultat du run associé au SHA fait foi.

Les réponses Mapbox des tests navigateur sont simulées. Aucun accès live, aucun
secret de production et aucune autorité altimétrique globale ne sont revendiqués.

Après cette tranche : tester manuellement le provider réel dans un laboratoire
publié séparément, résoudre la stratégie d'altitude canonique, puis passer aux
workers / chargements progressifs. Ne pas annoncer une carte jouable infinie.
