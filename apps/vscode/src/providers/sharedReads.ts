import { serialize, deserialize } from 'v8';

/** Short-lived, instance-scoped read sharing. Failed reads are never cached. */
export class SharedReads {
  private readonly entries = new Map<string, { promise: Promise<unknown>; expires: number }>();
  constructor(private readonly ttl = 5000, private readonly now = Date.now) {}
  clear(): void { this.entries.clear(); }
  async read<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry || entry.expires <= this.now()) {
      if (this.entries.size >= 1000) this.entries.clear();
      const next = { promise: Promise.resolve().then(fetch) as Promise<unknown>, expires: Infinity };
      this.entries.set(key, next);
      next.promise.then(() => { next.expires = this.now() + this.ttl; }, () => {
        if (this.entries.get(key) === next) this.entries.delete(key);
      });
      entry = next;
    }
    // Consumers may enrich MR records. Never mutate another view's cached response.
    return deserialize(serialize(await entry.promise)) as T;
  }
}
