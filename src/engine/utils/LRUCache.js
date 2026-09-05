export default class LRUCache {
  constructor(limit = 128, onEvict = null) {
    this.limit = limit;
    this.map = new Map();
    this.onEvict = onEvict;
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldestKey = this.map.keys().next().value;
      const oldestValue = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (this.onEvict) this.onEvict(oldestValue, oldestKey);
    }
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    const value = this.map.get(key);
    const deleted = this.map.delete(key);
    if (deleted && this.onEvict) this.onEvict(value, key);
    return deleted;
  }

  clear() {
    this.map.clear();
  }
}
