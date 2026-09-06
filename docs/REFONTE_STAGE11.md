# Étape 11a — profils routiers et terrassement de validation

## État et périmètre

Base examinée : `7ad70eeddf993a5a0d9486da71f3e5c62b452700` (PR10 fusionnée).
La publication PR10 avait réussi, mais le contrôle public Mapbox avait échoué
sur `ROAD_SURFACE_VERTEX_BUDGET`. Sept cellules étaient déjà générées ; aucune
erreur HTTP ou JavaScript n’était signalée dans ce rapport. Ce défaut n’était
pas visible dans les seules petites fixtures de CI.

Cette tranche apporte un noyau réutilisable de profils et un premier parcours
jouable **synthétique**. Elle ne déclare pas achevé le terrassement mondial.
La V1, les assets, les dépendances et le Geo Kernel sont conservés.

## Utilisation

Dans le laboratoire V2, choisir la source synthétique, puis dans les réglages
« Piste d’essai — profil aménagé », avec le lieu Paris et le niveau 19. Le mode
normal active toujours automatiquement le joueur, les routes et le streaming.

Accès direct : `/Zerana/v2/?source=synthetic&profile=engineering&level=19`.
La variante `profile=engineering-raw` conserve le relief brut de la même piste.
Ces deux sources et leurs caches ont des identités distinctes. Aucun appel
Mapbox n’est nécessaire. La piste est fictive : un arc de rayon 650 m et de
longueur 1 200 m, pas une route parisienne observée.

Le terrain est déjà aménagé avant la création du mesh et du collider. Un
changement d’origine ne recalcule ni le profil ni les buffers. Les cellules
nouvellement chargées évaluent la même fonction de hauteur globale.

## Calculs

- Lissage longitudinal à mémoire et travail linéaires : minimisation d’une
  erreur aux altitudes et d’une pénalité de seconde différence, avec hauteurs
  d’extrémité imposées. Les unités et le solveur sont décrits dans ADR-011.
- Interpolation cubique de Hermite, continuité de hauteur et de pente ; bornes
  analytiques de pente, variation de pente et écart au terrain longitudinal.
- Dévers basé sur une vitesse de conception et une courbure **estimées**, jamais
  sur la vitesse instantanée du joueur. Les transitions reviennent à zéro près
  des raccordements définis par la recette.
- Bombement transversal et blend quintique vers le relief naturel ; rejet
  explicite d’un déblai/remblai excessif, sans écrêter les altitudes.
- `structure-required` signale un profil non admissible. Cela ne prouve pas
  qu’un pont, un tunnel ou un mur particulier existe dans la réalité.

## Correctif des surfaces PR10

Le format `zerana-road-surface-v2` partage uniquement les tuples GPU Float32
strictement identiques (position, normale, couleur, UV) à travers un index.
Pas de tolérance de soudure géographique et pas de triangle supprimé. Trois
empreintes de buffers développés produites par la baseline vérifient l’identité
exacte du résultat. Une fixture dense dépasse l’ancien plafond de sommets
répétés sans dépasser 24 000 sommets uniques ni 2 Mio par paquet.

Les plafonds de complexité et de mémoire restent actifs. Le nouveau format
n’autorise pas une taille mondiale illimitée. Les compteurs mesurent les
payloads, pas le heap JavaScript ou la VRAM du pilote.

## Ce qui reste avant activation générale sur Mapbox

Il faut construire des corridors stables indépendants des WorldCells à partir
d’un graphe et d’un contexte source suffisants, partager les altitudes/pentes
aux carrefours, figer la révision du DEM utilisée et valider toutes les emprises
de terrassement. Le changement de sol devra publier **terrain, routes et
collisions ensemble**, avec un traitement explicite du joueur déjà présent.
Une correction du mesh routier seule au-dessus du collider actuel est interdite.

La grille de terrain actuelle ne représente pas exactement un profil cubique
ou un bombement étroit. L’écart de discrétisation doit être mesuré avant une
qualification de conduite ; la tolérance inter-cellules ne certifie pas la
fidélité au profil analytique. Aucun terrassement Mapbox n’est activé en
attendant ces adaptations. Ponts/tunnels, murs, revêtements détaillés, voies,
marquages, trafic et régulations nationales restent hors périmètre.

## Validation

Tests CPU : solveur comparé à un calcul matriciel dense NumPy indépendant,
extrêmes internes des polynômes, entrées adversariales, refus de profils,
rebases, neuf cellules construites dans les deux ordres et rayons sur les
colliders réels. Le navigateur vérifie une marche de 80 m et un retour de 80 m,
le recyclage, trois recentrages et le passage à la référence brute.

Les résultats CI/publics sont consignés dans la PR après exécution. La présence
d’un test n’est pas sa réussite ; ni ce parcours ni ses compteurs ne constituent
une validation sur plusieurs heures, Safari, un GPU matériel ou tout le réseau
mondial. Le test Mapbox des surfaces reste distinct du test de terrassement.
