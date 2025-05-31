// Gérer affichage / cache joueur
import EventBus from '../core/EventBus.js';

export default class PlayerVisibility {
  constructor(playerObject3D) {
    this.playerObject3D = playerObject3D;

    // Au départ, on cache le joueur
    if (this.playerObject3D) {
      this.playerObject3D.visible = false;
    }

    EventBus.on('addressSaved', () => {
      if (this.playerObject3D) {
        this.playerObject3D.visible = true;
      }
    });
  }
}