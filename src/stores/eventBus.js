// Lightweight event bus with optional sticky payloads
class EventBus {
  constructor() {
    this.events = new Map();
    this.lastPayloads = new Map();
  }

  on(event, listener, { immediate = true } = {}) {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event).add(listener);
    if (immediate && this.lastPayloads.has(event)) {
      listener(this.lastPayloads.get(event));
    }
  }

  off(event, listener) {
    const set = this.events.get(event);
    if (!set) return;
    set.delete(listener);
  }

  emit(event, payload, { sticky = false } = {}) {
    if (sticky) this.lastPayloads.set(event, payload);
    const set = this.events.get(event);
    if (!set) return;
    set.forEach((listener) => listener(payload));
  }
}

const eventBus = new EventBus();
export default eventBus;
