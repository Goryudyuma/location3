export interface Payload {
  body: string;
  count: number;
}

// Limit both the number of years and retained string storage. A single national
// GeoJSON response can exceed the whole budget, in which case it is not cached.
export class PayloadCache {
  private entries = new Map<string, Payload>();
  private bytes = 0;
  private maxEntries: number;
  private maxBytes: number;

  constructor(maxEntries = 3, maxBytes = 8 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string): Payload | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, payload: Payload): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.body.length * 2;
      this.entries.delete(key);
    }

    // Two bytes per UTF-16 code unit is a conservative string-storage estimate.
    const bytes = payload.body.length * 2;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;

    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.bytes -= this.entries.get(oldestKey)!.body.length * 2;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, payload);
    this.bytes += bytes;
  }
}
