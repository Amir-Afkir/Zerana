# ADR-004 — Préversion V2 isolée et vérification du site publié

Date : 5 septembre 2026. Périmètre : laboratoire V2 uniquement.

## Décision

Intégrer les trois tranches testées sans remplacer le prototype. Le même artifact
GitHub Pages contient V1 à `/Zerana/` et le laboratoire à `/Zerana/v2/`.
Un déploiement de la seule V2 remplacerait la racine : il est donc interdit.
Les PR sont fusionnées sans squash, dans l'ordre de leurs dépendances ; la branche
`legacy/v1` conserve `0e06c350b6c3d07699600e0003609790d60661c4`.

## Isolation vérifiable

`scripts/build-pages.mjs` refuse une différence avec la baseline sur `src/`,
`public/`, `index.html`, `package.json`, `package-lock.json` et `vite.config.js`.
Il construit V1, mémorise chaque empreinte SHA-256, ajoute la V2 dans un nouveau
sous-dossier et vérifie que tous les fichiers V1 sont inchangés. Les dépendances
et lockfiles ne sont pas mis à niveau par cette tranche. Node 22 est utilisé en CI.

Le manifest `deployment-manifest.json` et `v2/build-info.json` identifient le commit
construit. Ce sont des diagnostics de déploiement, pas une signature cryptographique
indépendante : l'identité attendue vient du SHA de GitHub Actions. Les tests HTTP
vérifient le commit publié, les deux HTML, le modèle V1 et les ressources chargées.

## Credentials et coûts

Seuls les tokens **publics** `pk.` sont admis dans un build navigateur. La variable
GitHub `VITE_MAPBOX_API_KEY` provient de l'environnement `Production` et est embarquée
par Vite : elle est donc visible dans le JavaScript public. Ce n'est pas un secret
privé caché. Un token public saisi manuellement peut remplacer celui du site ; une
saisie privée ou invalide échoue, sans retour silencieux au token du site.

La scène initiale est synthétique même lorsqu'un token de site est configuré.
Le chargement Mapbox exige une action et l'acceptation de la limite d'altitude.
Pas de stockage local/session, de préchargement global ou de boucle réseau de fond.
La CI de PR n'accède pas aux secrets et utilise des fixtures. Les rapports ne
conservent ni URL avec query string, ni token, ni corps de réponse, ni HAR.

Une vérification live est bornée à **48 tentatives HTTP Mapbox**, sur un seul patch
3x3 à Paris. Elle n'est pas exécutée sur les pushes ordinaires. Elle est activée
par l'option manuelle `verify_live_mapbox` ou par le marqueur explicite
`[verify-mapbox]` dans le commit de livraison. Ces appels peuvent être facturés.
Le scénario utilise l'origine HTTPS réellement déployée ; il n'usurpe pas l'origine
pour contourner les restrictions de token.

## Altitudes : exception limitée maintenue

Le mode Mapbox conserve `UNRESOLVED_DATUM_PREVIEW` et `altitudeAuthority: preview-only`.
L'exception ADR-003 est admise pour cette préversion explicitement étiquetée, pas
pour la future physique ou une altitude canonique. Aucune conversion de géoïde
n'est ajoutée. Un test live réussi atteste le transport/décodage/rendu sur son
échantillon, **pas** l'exactitude topographique absolue ou la couverture mondiale.
La référence normative fournie reste inchangée.

## Déploiement et retour arrière

Le workflow Pages exige les tests CPU, le build combiné et le contrôle navigateur
hors réseau avant publication. Après publication, une vérification distincte
contrôle l'URL publique et conserve ses preuves. Son échec ne signifie pas que
le déploiement a été annulé : consulter séparément `deploy` et `verify-published`.
Aucun rollback automatique n'est déclenché par une panne externe Mapbox.

En cas de régression de la préversion, revenir sur le merge de cette tranche par
un commit `git revert -m 1 <merge-de-cette-tranche>`, sans force-push. L'ancien
workflow republie alors V1 seule. Ne pas supprimer la baseline ni réécrire l'historique.

## Références primaires

- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://vite.dev/guide/static-deploy.html
- https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/

## Non couvert

Ni joueur mobile/physique, ni streaming, ni workers, ni géoïde mondial, ni benchmark
GPU matériel. Chromium/SwiftShader en CI ne certifie pas Safari ou les performances
du PC du joueur. Aucun de ces points n'est présenté comme achevé.
