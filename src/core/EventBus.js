// core/EventBus.js
class EventBus {
  constructor() {
    this.events = {};
    this.lastPayloads = {}; // Mémorise le dernier payload pour chaque event
  }

  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
    // Si un payload a déjà été émis, appelle le listener tout de suite
    if (this.lastPayloads[event] !== undefined) listener(this.lastPayloads[event]);
  }

  off(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  emit(event, payload) {
    this.lastPayloads[event] = payload;
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(payload));
  }
}

const eventBus = new EventBus();
export default eventBus;