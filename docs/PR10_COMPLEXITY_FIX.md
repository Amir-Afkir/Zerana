# Complément de livraison PR10 / PR11 — partition convexe

Le run public `34021302628`, commit `5c4ba65451c68f8e0cdd58cd6c2caa95f4cc429f`,
a validé la piste synthétique et les régressions. Le test Mapbox réel a enfin
chargé les neuf cellules initiales de Paris niveau 17 : 2 278 954 octets de
payloads routiers, sans dépassement du plafond de sommets. Le déplacement a
ensuite révélé `ROAD_SURFACE_COMPLEXITY_BUDGET` sur une cellule voisine.
Aucune erreur HTTP ou JavaScript n'était enregistrée dans ce parcours.

## Cause et correction

La partition soustractive scindait des morceaux non couverts par les droites
supports d'un polygone pourtant disjoint. Ces coupes inutiles multipliaient
les fragments avant d'atteindre le plafond de 192 morceaux par triangle.

Un test d'axe séparateur précède désormais la partition des deux polygones
convexes CCW. Si toute la deuxième forme reste dans le demi-plan extérieur
d'un côté de la première (ou réciproquement), leur intersection a une aire
nulle : le morceau initial est conservé entier. Les prédicats orientés restent
les mêmes ; aucune nouvelle tolérance ou soudure géographique n'est ajoutée.
Les intersections non vides gardent l'algorithme précédent.

## Garde-fous et preuves

Les plafonds de 192 morceaux, 150 000 opérations, 24 000 sommets uniques,
24 000 triangles, 2 Mio par paquet et 8 Mio résidents ne sont pas augmentés.
Six tests ajoutent contacts, recouvrements très fins, trous et 500 paires
convexes déterministes comparées à l'algorithme antérieur. La régression de
jonction passe de 256 morceaux / 16 258 partitions à un morceau / 129
partitions, à couverture identique. Les trois empreintes développées de la
régression d'indexation PR10 restent inchangées sur leurs fixtures.

Tous les tests historiques restent actifs. Le contrôle réel conserve Paris,
le niveau 17, les neuf cellules initiales, la marche de 90 m puis le retour et
le plafond externe de 128 tentatives Mapbox. Aucun changement de lieu, niveau
ou seuil n'est utilisé pour contourner l'échec. La réussite après publication
doit être consignée dans les PR une fois observée, pas déduite de ce document.

Ce correctif ne modifie pas les profils PR11, n'active pas le terrassement
Mapbox, et ne change ni la V1, ni le Geo Kernel, ni les dépendances.
