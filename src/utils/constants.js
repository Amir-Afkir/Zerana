// Constantes globales (taille chunk, zoom...)
export const CHUNK_SIZE = 100;          // Taille d’un chunk en unités (mètres ou unité de jeu)
export const GRID_SIZE = 5;             // Nombre de chunks chargés autour du joueur (rayon)
export const ZOOM_LEVEL = 17;           // Niveau de zoom utilisé pour les tuiles Mapbox
export const MAX_TREES_PER_CHUNK = 100; // Limite maximale d’arbres par chunk (pour performances)
export const PLAYER_HEIGHT = 2;         // Hauteur du joueur (pour caméra, collisions)
export const TERRAIN_GRID_SIZE = 65;    // Résolution de la heightmap (ex: 64 + 1)