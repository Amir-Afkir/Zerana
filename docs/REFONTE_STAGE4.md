# Étape 4 — Intégration et préversion publique

## Base

Branche `feature/v2-public-preview`, issue de
`f29222c15d0518d93796982ed9ed265e827e410e` (étapes 1–3).
La référence normative et les sources/ressources de V1 sont conservées.

## Livrable

Build combiné V1 + laboratoire, empreintes des fichiers V1, identification du
commit publié, navigation retour vers V1, token public de site facultatif et
contrôles de déploiement. Voir [ADR-004](adr/ADR-004-isolated-public-preview.md).

Après déploiement validé sur main :

- Jeu historique : `https://amir-afkir.github.io/Zerana/`.
- Laboratoire : `https://amir-afkir.github.io/Zerana/v2/`.

Dans le laboratoire, sélectionner Mapbox, accepter l'aperçu d'altitude puis
« Générer la scène ». Le champ token peut rester vide lorsque le token du site
est configuré. Le token est public par conception et peut être restreint au domaine
Pages dans Mapbox. Aucun chargement Mapbox n'est déclenché à l'ouverture de la page.

## Vérification

Ne pas confondre implémentation, CI et disponibilité publique. La PR de livraison
et les artifacts GitHub Actions consignent le SHA exact et les résultats observés.

- 9 tests ajoutés pour les credentials publics et les garde-fous de publication.
- 171 tests antérieurs conservés ; suite totale attendue : 180.
- Scénarios synthétiques et fournisseur simulé antérieurs conservés.
- Nouveau scénario navigateur du site combiné, avec hash des HTML/modèle V1,
  formulaire V1, préversion, défaut hors réseau et token de site avec fixtures.
- Contrôle post-déploiement sur le vrai domaine ; live Mapbox optionnel, borné,
  sans simulation lorsque `ZERANA_LIVE_MAPBOX=1`.

Un test live valide seulement les vraies requêtes et la scène échantillonnée.
Les datums, la qualité topographique, Safari et la fluidité matérielle ne sont pas
certifiés par ce test. Les captures simulées et live portent des labels distincts.

## Prochaine tranche technique

Revenir au Milestone 4 de la référence : contrôleur de joueur métrique, déplacement
et origine flottante appliquée aux poses ; tests au franchissement des cellules.
Le streaming continu et le cache longue durée suivent au Milestone 5. Le laboratoire
n'est pas encore le jeu final et ne doit pas être présenté comme un monde infini.
