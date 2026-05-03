export class MemoryCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | null {
    const current = this.store.get(key);

    if (!current) {
      return null;
    }

    if (Date.now() > current.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return current.value;
  }

  set(key: string, value: T): T {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    return value;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}

