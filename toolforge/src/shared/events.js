import { newId } from './ids.js';
import { now } from './time.js';

/**
 * In-process pub/sub with a bounded replay buffer, so a dashboard that
 * reconnects can catch up on what it missed instead of showing a blank slate.
 */
export class EventBus {
  /** @param {number} [bufferSize] */
  constructor(bufferSize = 500) {
    this.bufferSize = bufferSize;
    /** @type {{id: string, seq: number, ts: string, type: string, data: any}[]} */
    this.buffer = [];
    /** @type {Set<(event: any) => void>} */
    this.listeners = new Set();
    this.seq = 0;
  }

  /**
   * @param {string} type Dotted event name, e.g. `task.succeeded`.
   * @param {Record<string, unknown>} [data]
   * @returns {{id: string, seq: number, ts: string, type: string, data: any}}
   */
  emit(type, data = {}) {
    const event = { id: newId('evt', 8), seq: ++this.seq, ts: now(), type, data };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never take the hub down with it.
      }
    }
    return event;
  }

  /**
   * @param {(event: any) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * @param {number} [afterSeq] Return only events newer than this sequence number.
   * @param {number} [limit]
   * @returns {{id: string, seq: number, ts: string, type: string, data: any}[]}
   */
  since(afterSeq = 0, limit = this.bufferSize) {
    return this.buffer.filter((event) => event.seq > afterSeq).slice(-limit);
  }
}
