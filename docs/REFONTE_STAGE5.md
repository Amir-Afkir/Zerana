# Étape 5 — Joueur métrique (Milestone 4 de la référence)

Base protégée : `07ac40b699d2f200e1dd21b3f4900c9d0be827fd`.
Branche : `feature/v2-metric-player`. Le jeu V1 reste à `/Zerana/`.

## Utilisation après livraison

Ouvrir `/Zerana/v2/`, générer une scène, puis **Marcher** dans le bloc **Joueur métrique**.
ZQSD / WASD ou flèches : déplacement ; Maj : course ; Espace : saut ; glisser la
souris avec le bouton gauche : regard ; Échap : pause. **Réapparaître** revient au
point initial sans recharger les tuiles. **Vue d'ensemble** et **Échelle humaine**
remettent la caméra en mode inspection et interrompent la marche.

Commencer avec neuf cellules et 32 subdivisions. Le bord du patch bloque la marche :
il ne s'agit pas encore de streaming. Le seuil **32 m — test rapproché** permet
d'observer les recentrages automatiques sans sortir d'un petit patch. Le réglage
normal est 2 048 m. La capsule de 1,80 m ne change jamais d'échelle.

La marche est disponible sur la scène synthétique et, après consentement existant,
sur le terrain Mapbox en mode expérimental. Ce second cas conserve les badges
d'altitude approximative. Aucun chargement Mapbox automatique n'est ajouté.

## Architecture

- `src/physics/geometry.ts` : distances géométriques, rayon et BVH.
- `src/physics/terrain-physics.ts` : colliders locaux, balayage, support, rebase.
- `src/runtime/metric-player.ts` : autorité ECEF, mouvement, saut, caméra.
- `src/runtime/fixed-clock.ts` : simulation fixe et temps écarté.
- `demo/runtime/player-session.mjs` : commandes clavier/souris et adaptateur Three.js.
- `tests/player.test.mjs` et `tests/browser/player_smoke.py` : validation reproductible.

Voir [ADR-005](adr/ADR-005-metric-player-and-terrain-collision.md) pour les unités,
formules, budgets, hypothèses et limites. Les compteurs sont aussi exposés dans
`window.__ZERANA_PLAYER_DEBUG__`, sans secret ni donnée d'identification du joueur.

## Vérifications avant publication de la branche

TypeScript 5.8.3 strict : réussi dans l'environnement de travail.
33 nouveaux tests CPU : réussis, sans test ignoré. Les fichiers CPU de la base ont
été restaurés depuis l'artifact précédent ; les fichiers modifiés main/renderer
correspondent aux blobs de GitHub avant modification.

Le navigateur de l'environnement de travail refuse HTTP (`ERR_BLOCKED_BY_ADMINISTRATOR`).
La validation navigateur sera donc faite par GitHub Actions, sans prétendre à une
validation locale. La suite complète, la compatibilité Pages, les résultats du
navigateur et le déploiement doivent être confirmés dans la PR de cette tranche.

## Limites et suite

Capsule cinématique sur terrain statique ; pas de modèle animé, bâtiments, routes,
arbres, escalier automatique, moteur de corps rigides, tactile, certification Safari
ou mesure GPU matériel. Le collider copie le maillage installé ; sa sélection de
résolution n'est pas encore indépendante de celle du visuel.

Prochain jalon : streaming progressif, ordonnanceur, cache, workers, annulation et
sécurité du terrain sous le joueur (Milestone 5), avant les couches vectorielles.
