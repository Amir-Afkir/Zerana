# Laboratoire raster — étape 3

La démo isolée ajoute un mode Mapbox au terrain synthétique de la PR #2.
Ce n'est pas encore le jeu V2 en production ni un monde en streaming.

## Essai manuel

Après installation des dépendances racine et V2, utiliser les commandes de
`v2/demo/README.md`. Le build conserve le sous-chemin `/Zerana/v2/`.
Sélectionner **Mapbox — satellite et relief**, fournir un token PUBLIC `pk.`
restreint au domaine de test et activer explicitement l'aperçu approximatif.
Le token n'est ni versionné ni sauvegardé dans localStorage/sessionStorage.
La clé de production GitHub Actions n'est pas lue par cette branche.

Changer de lieu ou annuler conserve la dernière scène valide en cas d'erreur.
Le mode synthétique ne fait aucun appel Mapbox et reste sélectionné au démarrage.

## Pourquoi un avertissement d'altitude ?

Le provider mélange des datums. L'aperçu place les hauteurs source sur l'ellipsoïde
sans inventer une correction géoïde. Le badge **DATUM NON RÉSOLU** et les paquets
`preview-only` interdisent de confondre ce rendu avec des altitudes absolues
validées. Le chemin strict, lui, refuse ces données. Voir ADR-003.

## Contrôles automatisés

- `cd v2 && npm run check` : suite noyau/terrain/raster.
- `npm --prefix v2 run demo:build` : build HTTP sous-chemin.
- `npm --prefix v2 run demo:test` : régression synthétique existante.
- `python v2/tests/browser/provider_smoke.py` : parcours fournisseur avec réponses
  PNG générées et interceptées, sans vraie clé ni requête Mapbox.

Les captures du test fournisseur sont marquées **TEST AUTOMATISÉ / TUILES SIMULÉES**.
Un résultat CI vert ne constitue pas un test live du compte Mapbox.
Les preuves sont conservées dans l'artifact CI `v2-raster-demo-and-evidence`.

## Limites de cette tranche

Pas de géoïde mondial fourni, pas de DEM ellipsoïdal global validé, pas de
téléchargement en arrière-plan ni de cache persistant. Génération de 1/4/9 cellules
uniquement. Le provider navigateur est isolé dans `demo/providers/` ; les calculs
réutilisables restent sans DOM/réseau dans `src/providers/raster/`.
