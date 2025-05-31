import eventBus from './core/EventBus.js';
import { MAPBOX_API_KEY } from './utils/constants.js';
import HtmlHandler from './ui/HtmlHandler.js';

window.onload = () => {
  eventBus.emit('attributs:ready', { apiKey: MAPBOX_API_KEY });  // Clé API envoyée

  new HtmlHandler(document.body);  // Instanciation après émission
};