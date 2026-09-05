import eventBus from '../stores/eventBus.js';

export default class InputManager {
  constructor(target = window) {
    this.target = target;
    this.onKeyDown = (event) => eventBus.emit('keyDown', event.code);
    this.onKeyUp = (event) => eventBus.emit('keyUp', event.code);
  }

  connect() {
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
  }

  dispose() {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
  }
}
