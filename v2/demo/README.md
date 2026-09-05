# Laboratoire terrain Zerana V2

**Démo synthétique isolée — ce n'est pas encore le jeu V2.**

Prérequis : Node >=22, dépendances verrouillées du dépôt racine installées (`npm ci`).
Le noyau n'importe ni Three.js ni Vite ; seule cette démo utilise leurs dépendances racine.

Depuis la racine du dépôt :

```sh
npm ci
npm --prefix v2 ci --ignore-scripts
npm --prefix v2 run check
npm --prefix v2 run demo:dev
```

Ouvrir `http://127.0.0.1:5174/Zerana/v2/`.

Build séparé, sans remplacer `dist/` du jeu existant :

```sh
npm --prefix v2 run demo:build
```

Sortie : `v2/demo-dist/`, prévue pour `/Zerana/v2/`.
Une branche de feature n'est **pas** publiée sur GitHub Pages par cette étape.
La CI conserve un artifact avec le build et les captures, sans clé de production.

Test navigateur du build avec un serveur HTTP strict au même sous-chemin :

```sh
python -m pip install -r v2/tests/browser/requirements.txt
python -m playwright install chromium
npm --prefix v2 run demo:test
```

Sous Linux sans dépendances système, utiliser `python -m playwright install --with-deps chromium`.
Les captures et résultats sont dans `v2/browser-results/`.

## Contrôles

Choisir longitude/latitude, 1/4/9 cellules, niveau 15/17/19/21, relief `flat` ou
`waves`, puis générer. Le bouton Échelle humaine cadre une capsule de 1,80 m.
Déplacer l'origine applique la transformation rigide aux cellules et à la caméra,
sans recréer leurs buffers. La donnée exposée à `window.__ZERANA_TERRAIN_DEBUG__`
sert aux vérifications, sans accès à un secret ou à un provider.

Le quadrillage UV est synthétique et répété dans chaque cellule. Couleurs des coins :
NO rouge, NE bleu, SO jaune, SE blanc. La grille métrique est tangente, pas géodésique.
`flat` signifie altitude ellipsoïdale nulle : la courbure terrestre reste présente.

## Limites

Pas de Mapbox/OSM, pas de satellite/DEM, pas de joueur mobile, pas de collider,
pas de streaming, pas de LOD mixte, pas de worker. La génération à la demande est
synchrone et bornée. L'estimation de raccord Float32 ne remplace pas une mesure GPU.
Les nombres affichés ne prouvent pas la fluidité sur une carte graphique réelle.

Décision et formules : `../../docs/adr/ADR-002-synthetic-terrain-patches.md`.
