// Gestionnaire d'événements global (mitt)
class EventBus {
  constructor() {
    this.events = {};
  }

  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  }

  off(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  emit(event, payload) {
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(payload));
  }
}

const eventBus = new EventBus();
export default eventBus;