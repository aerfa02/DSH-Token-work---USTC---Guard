/** Bounded FIFO admission queue. Waiting owns no RPM, slot or reservation. */
export class AdmissionQueue {
  #items = [];
  #timer;
  #closed;
  constructor({ acquire, maxLength, waitMs }) {
    this.acquire = acquire;
    this.maxLength = maxLength;
    this.waitMs = waitMs;
  }
  get length() { return this.#items.length; }
  acquireSlot(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.#closed) return Promise.reject(this.#closed);
    if (!this.length) {
      const result = this.acquire();
      if (result.ok) return Promise.resolve(result);
    }
    if (this.length >= this.maxLength) return Promise.reject(this.#error('USTC_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, deadline: Date.now() + this.waitMs, signal };
      item.abort = () => this.#remove(item, signal.reason ?? this.#error('ABORTED'));
      signal?.addEventListener('abort', item.abort, { once: true });
      this.#items.push(item);
      this.wake();
    });
  }
  #error(code) { return Object.assign(new Error(code), { code }); }
  #remove(item, error) {
    const index = this.#items.indexOf(item);
    if (index < 0) return;
    this.#items.splice(index, 1);
    item.signal?.removeEventListener('abort', item.abort);
    item.reject(error);
    this.wake();
  }
  wake() {
    clearTimeout(this.#timer);
    while (this.length) {
      const item = this.#items[0];
      if (item.deadline <= Date.now()) {
        this.#items.shift();
        item.signal?.removeEventListener('abort', item.abort);
        item.reject(this.#error('USTC_RATE_BLOCKED'));
        continue;
      }
      const result = this.acquire();
      if (!result.ok) {
        this.#timer = setTimeout(() => this.wake(), Math.max(1, Math.min(
          item.deadline - Date.now(), result.retryAtMs ?? 1000,
        )));
        return;
      }
      this.#items.shift();
      item.signal?.removeEventListener('abort', item.abort);
      item.resolve(result);
    }
  }
  close(error = this.#error('USTC_GUARD_UNAVAILABLE')) {
    this.#closed = error;
    clearTimeout(this.#timer);
    for (const item of this.#items.splice(0)) {
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(error);
    }
  }
  reopen() { this.#closed = undefined; }
}
