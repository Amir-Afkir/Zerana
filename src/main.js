// src/main.js
import eventBus from './core/EventBus.js';
import { MAPBOX_API_KEY } from './utils/constants.js';
import HtmlHandler from './ui/HtmlHandler.js';
import { App } from './core/App.js';

window.onload = () => {
  eventBus.emit('attributs:ready', { apiKey: MAPBOX_API_KEY });

  // Lancer tout de suite l’application (sans carte encore)
  const app = new App();
  app.init();
  window.app = app;

  // Afficher formulaire
  new HtmlHandler(document.body);

  // Quand l’adresse est validée, repositionner le joueur
  eventBus.on('addressSaved', () => {
    eventBus.emit('player:reposition');
  });
};