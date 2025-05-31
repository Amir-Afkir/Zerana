// core/EventBus.js
class EventBus {
  constructor() {
    this.events = {};
    this.lastPayloads = {};  // <== cache des derniers événements
  }

  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
    // Appeler immédiatement si on a un dernier payload connu
    if (this.lastPayloads[event]) listener(this.lastPayloads[event]);
  }

  off(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  emit(event, payload) {
    this.lastPayloads[event] = payload;  // <== stocker dernier payload
    if (!this.events[event]) return;
    this.events[event].forEach(listener => listener(payload));
  }
}

const eventBus = new EventBus();
export default eventBus;