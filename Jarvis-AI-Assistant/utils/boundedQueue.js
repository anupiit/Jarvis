// Bounded FIFO queue. enqueue() appends; dequeue() removes the oldest item.
// requeueFront() is used only for retries of work that was already admitted.

class QueueFullError extends Error {
  constructor(maxSize) {
    super(`Queue is full (max ${maxSize} pending requests)`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
  }
}

class BoundedQueue {
  constructor(maxSize = 50) {
    if (!(maxSize > 0)) throw new Error('maxSize must be > 0');
    this.maxSize = maxSize;
    this.items = [];
    this.highWaterMark = 0;
  }

  get length() {
    return this.items.length;
  }

  isFull() {
    return this.items.length >= this.maxSize;
  }

  enqueue(item) {
    if (this.isFull()) throw new QueueFullError(this.maxSize);
    this.items.push(item);
    if (this.items.length > this.highWaterMark) this.highWaterMark = this.items.length;
    return this.items.length;
  }

  /** Put already-admitted work back at the front (retries keep their place in line). */
  requeueFront(item) {
    this.items.unshift(item);
    if (this.items.length > this.highWaterMark) this.highWaterMark = this.items.length;
  }

  dequeue() {
    return this.items.shift();
  }

  peek() {
    return this.items[0];
  }

  remove(item) {
    const index = this.items.indexOf(item);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  drain() {
    const all = this.items;
    this.items = [];
    return all;
  }
}

module.exports = { BoundedQueue, QueueFullError };
