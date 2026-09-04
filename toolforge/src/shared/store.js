import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './log.js';
import { notFound } from './errors.js';

const log = logger('store');

/**
 * A tiny persistent document store: the whole graph lives in memory and is
 * flushed to a single JSON file with an atomic write-then-rename.
 *
 * The hub is single-threaded, so in-memory mutation needs no locking; the only
 * thing that has to be careful is the flush, which is serialised below.
 */
export class Store {
  /**
   * @param {string} file Path to the JSON file backing this store.
   * @param {Record<string, unknown>} defaults Shape used when the file is absent.
   * @param {{flushDelayMs?: number}} [opts]
   */
  constructor(file, defaults, opts = {}) {
    this.file = file;
    this.defaults = defaults;
    this.flushDelayMs = opts.flushDelayMs ?? 150;
    /** @type {any} */
    this.data = structuredClone(defaults);
    this.dirty = false;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** @type {Promise<void>} */
    this.writing = Promise.resolve();
    this.closed = false;
  }

  /**
   * @param {string} file
   * @param {Record<string, unknown>} defaults
   * @param {{flushDelayMs?: number}} [opts]
   * @returns {Promise<Store>}
   */
  static async open(file, defaults, opts) {
    const store = new Store(file, defaults, opts);
    await store.load();
    return store;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...structuredClone(this.defaults), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.warn('could not read state file, starting from defaults', {
          file: this.file,
          error: error.message,
        });
      }
      this.data = structuredClone(this.defaults);
    }
    return this.data;
  }

  /** Mark the store dirty and schedule a flush. */
  save() {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  /** Write pending changes to disk now. @returns {Promise<void>} */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(() => this.#write(snapshot)).catch((error) => {
      log.error('failed to persist state', { file: this.file, error: error.message });
      this.dirty = true;
    });
    return this.writing;
  }

  async #write(snapshot) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, this.file);
  }

  /** Flush and stop accepting further writes. @returns {Promise<void>} */
  async close() {
    await this.flush();
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * @template T
   * @param {string} name
   * @param {string} label Human name used in "not found" errors.
   * @returns {Collection<T>}
   */
  collection(name, label) {
    if (!this.data[name]) this.data[name] = {};
    return new Collection(this, name, label);
  }
}

/**
 * A keyed set of documents inside a {@link Store}.
 * @template T
 */
export class Collection {
  /**
   * @param {Store} store
   * @param {string} name
   * @param {string} label
   */
  constructor(store, name, label) {
    this.store = store;
    this.name = name;
    this.label = label;
  }

  /** @returns {Record<string, T & {id: string}>} */
  get map() {
    return this.store.data[this.name];
  }

  /** @param {string} id @returns {(T & {id: string}) | undefined} */
  get(id) {
    return this.map[id];
  }

  /** @param {string} id @returns {T & {id: string}} */
  require(id) {
    const found = this.map[id];
    if (!found) throw notFound(this.label, id);
    return found;
  }

  /** @param {T & {id: string}} doc @returns {T & {id: string}} */
  insert(doc) {
    this.map[doc.id] = doc;
    this.store.save();
    return doc;
  }

  /**
   * @param {string} id
   * @param {(doc: T & {id: string}) => void} mutate
   * @returns {T & {id: string}}
   */
  update(id, mutate) {
    const doc = this.require(id);
    mutate(doc);
    this.store.save();
    return doc;
  }

  /** @param {string} id @returns {boolean} */
  remove(id) {
    if (!this.map[id]) return false;
    delete this.map[id];
    this.store.save();
    return true;
  }

  /** @param {(doc: T & {id: string}) => boolean} [predicate] @returns {(T & {id: string})[]} */
  list(predicate) {
    const all = Object.values(this.map);
    return predicate ? all.filter(predicate) : all;
  }

  /** @param {(doc: T & {id: string}) => boolean} predicate @returns {(T & {id: string}) | undefined} */
  find(predicate) {
    return this.list().find(predicate);
  }

  /** @param {(doc: T & {id: string}) => boolean} [predicate] @returns {number} */
  count(predicate) {
    return this.list(predicate).length;
  }
}
