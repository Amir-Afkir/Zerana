export default class Semaphore {
  constructor(maxConcurrency = 4) {
    this.maxConcurrency = maxConcurrency;
    this.currentCount = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.currentCount--;
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      this.currentCount++;
      nextResolve();
    }
  }
}
