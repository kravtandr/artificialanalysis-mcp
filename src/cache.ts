export interface CacheResult<T> {
  value: T;
  dataAsOf: Date;
  stale: boolean;
}

interface Entry {
  value: unknown;
  fetchedAt: number;
}

/**
 * In-memory TTL-кэш с двумя инвариантами (SPEC.md §3.3):
 * - записи по истечении TTL не удаляются, а помечаются stale: при ошибке
 *   обновления (если staleEligible) отдаётся stale-копия с её возрастом;
 * - параллельные промахи по одному ключу коалесцируются в один вызов loader
 *   (в кэше живёт промис загрузки) — cache stampede при квоте 100/день недопустим.
 */
export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  private isFresh(entry: Entry): boolean {
    return this.now() - entry.fetchedAt < this.ttlSeconds * 1000;
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    staleEligible: (error: unknown) => boolean,
  ): Promise<CacheResult<T>> {
    const existing = this.entries.get(key);
    if (existing && this.isFresh(existing)) {
      return { value: existing.value as T, dataAsOf: new Date(existing.fetchedAt), stale: false };
    }

    let load = this.inFlight.get(key) as Promise<T> | undefined;
    if (!load) {
      load = loader().then((value) => {
        this.entries.set(key, { value, fetchedAt: this.now() });
        return value;
      });
      // Промис кладётся в Map до первого await — иначе дедупликации нет.
      this.inFlight.set(key, load);
      void load.catch(() => undefined).finally(() => this.inFlight.delete(key));
    }

    try {
      const value = await load;
      const entry = this.entries.get(key);
      const fetchedAt = entry && entry.value === (value as unknown) ? entry.fetchedAt : this.now();
      return { value, dataAsOf: new Date(fetchedAt), stale: false };
    } catch (error) {
      const staleCopy = this.entries.get(key);
      if (staleCopy && staleEligible(error)) {
        return {
          value: staleCopy.value as T,
          dataAsOf: new Date(staleCopy.fetchedAt),
          stale: true,
        };
      }
      throw error;
    }
  }

  /** Читает запись без загрузки и без учёта TTL-протухания (для диагностики). */
  peek<T>(key: string): CacheResult<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      value: entry.value as T,
      dataAsOf: new Date(entry.fetchedAt),
      stale: !this.isFresh(entry),
    };
  }

  inspect(): Array<{ key: string; ageSeconds: number; stale: boolean }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      ageSeconds: Math.round((this.now() - entry.fetchedAt) / 1000),
      stale: !this.isFresh(entry),
    }));
  }
}
