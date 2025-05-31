// Point d'entrée (bootstrap app)
import { App } from './core/App.js';

window.onload = () => {
  const app = new App();
  window.app = app; // Pour debug dans la console
};