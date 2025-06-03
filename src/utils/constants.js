// src/utils/constants.js

// Taille d’un chunk (en unités jeu, ex: mètres)
export const CHUNK_SIZE = 10; // Adapte à la réalité de ta map (100 recommandé)

// Nombre de chunks chargés autour du joueur (radius : 5 → 11x11 chunks)
export const GRID_SIZE = 5;

// Niveau de zoom pour Mapbox (impacte la taille réelle d’un chunk sur la planète)
export const ZOOM_LEVEL = 17; 

// API key Mapbox depuis .env (sécurisé)
export const MAPBOX_API_KEY = import.meta.env.VITE_MAPBOX_API_KEY;