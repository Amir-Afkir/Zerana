# État de la refonte Zerana V2

## Baseline protégée

- Commit de départ : `0e06c350b6c3d07699600e0003609790d60661c4`.
- Sauvegarde Git distante : `legacy/v1`.
- Branche de travail initiale : `feature/v2-geo-kernel`.
- Référence fournie : `ZERANA_ARCHITECTURE_REFERENCE(1).md`, version 1.0.0.
- SHA-256 du fichier fourni : `8fa7d13540eef938c423a83fc6e207743e48e9c9c9c33432eb10979979ce56f8`.
- La copie de travail locale du Mac n'a pas été modifiée par cette intervention.

## Première tranche

Implémenté dans `v2/src/geo/` : unités typées, WGS84, conversions ECEF/ENU,
repère Three, transformations d'origine flottante, Mercator et IDs de cellules.
Le noyau n'est pas branché sur le jeu existant.

Vérifié avant publication de la PR : contrôle TypeScript strict, tests de types,
lint des frontières, compilation et 80 tests Node réussis ; ces tests comprennent
32 cas PROJ/ECEF, 6 cas PROJ/ENU, 14 déplacements géodésiques d'un mètre et un
scénario de 500 changements de repère successifs.

Vérification supplémentaire hors CI : 5 000 positions confrontées à PROJ 9.5.1,
h entre -12 km et 100 000 km. Erreurs maximales observées en mètres :
- conversion avant : 2.59e-8 ;
- hauteur reconstruite : 4.48e-8 ;
- position reconstruite : 5.38e-8.
Ces valeurs sont des résultats sur cet échantillon, pas une preuve globale.

La CI ajoutée exécute les vérifications du noyau sur Node 22 et 24 et compile
séparément le jeu existant en mode Pages, sans secret de production et sans
publier la branche. Son résultat GitHub fait autorité pour l'installation avec
les lockfiles et pour le build du jeu existant.

## Ce qui n'est PAS terminé

- Milestone 0 : le lint est ciblé au noyau ; pas de lint/formatage global du legacy.
- Milestone 1 : noyau numérique livré, pas de déplacement GPU/physique intégré.
- Milestones 2–9 : terrain, raccords de meshes, scène métrique, runtime V2,
  streaming, workers, cache, LOD, couches réelles et procédurales restent à faire.
- Aucun test interactif de fluidité sur GPU réel n'est revendiqué.
- Aucun nouveau jeu V2 n'est publié dans cette tranche.

## Prochaine tranche autorisée

Une cellule synthétique à échelle métrique, sans accès réseau, avec ancrage,
axes, grille, repères de position et tests de géométrie. Puis 4/9 cellules
avec samples canoniques partagés. Ne pas ajouter les façades avant cette étape.
