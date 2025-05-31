// Gestion des entrées clavier/souris
import EventBus from './EventBus.js';

export default class InputManager {
  constructor() {
    this.keysPressed = new Set();

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  onKeyDown(event) {
    if (!this.keysPressed.has(event.code)) {
      this.keysPressed.add(event.code);
      EventBus.emit('keyDown', event.code);
    }
  }

  onKeyUp(event) {
    if (this.keysPressed.has(event.code)) {
      this.keysPressed.delete(event.code);
      EventBus.emit('keyUp', event.code);
    }
  }

  isKeyPressed(keyCode) {
    return this.keysPressed.has(keyCode);
  }
}