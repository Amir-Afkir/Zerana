// src/main.js
import eventBus from './core/EventBus.js';
import { MAPBOX_API_KEY } from './utils/constants.js';
import HtmlHandler from './ui/HtmlHandler.js';
import { App } from './core/App.js';

window.onload = () => {
  // Émettre la clé API pour que les modules l’utilisent
  eventBus.emit('attributs:ready', { apiKey: MAPBOX_API_KEY });

  // Démarrer le formulaire d’adresse
  new HtmlHandler(document.body);

  // Quand l’adresse est validée, démarrer le jeu
  eventBus.on('addressSaved', () => {
    const app = new App();
    app.init();
    window.app = app;
  });
};