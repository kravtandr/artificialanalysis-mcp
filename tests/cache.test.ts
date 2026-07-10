import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const staleOnAny = () => true;
const staleNever = () => false;

describe('TtlCache', () => {
  it('loads on miss and serves fresh hits without calling the loader again', async () => {
    let now = 1_000_000;
    const cache = new TtlCache(60, () => now);
    let calls = 0;
    const load = () => {
      calls += 1;
      return Promise.resolve('v1');
    };
    const first = await cache.getOrLoad('k', load, staleNever);
    expect(first).toMatchObject({ value: 'v1', stale: false });
    now += 30_000;
    const second = await cache.getOrLoad('k', load, staleNever);
    expect(second.value).toBe('v1');
    expect(second.stale).toBe(false);
    expect(calls).toBe(1);
  });

  it('refreshes an expired entry when the loader succeeds', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    let calls = 0;
    const load = () => Promise.resolve(`v${++calls}`);
    await cache.getOrLoad('k', load, staleNever);
    now = 61_000;
    const result = await cache.getOrLoad('k', load, staleNever);
    expect(result.value).toBe('v2');
    expect(result.stale).toBe(false);
    expect(result.dataAsOf.getTime()).toBe(61_000);
  });

  it('serves the stale copy when refresh fails with an eligible error', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    await cache.getOrLoad('k', () => Promise.resolve('old'), staleNever);
    now = 100_000;
    const result = await cache.getOrLoad(
      'k',
      () => Promise.reject(new Error('rate limited')),
      staleOnAny,
    );
    expect(result).toMatchObject({ value: 'old', stale: true });
    expect(result.dataAsOf.getTime()).toBe(0);
  });

  it('rethrows a non-eligible error even when a stale copy exists', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    await cache.getOrLoad('k', () => Promise.resolve('old'), staleNever);
    now = 100_000;
    await expect(
      cache.getOrLoad('k', () => Promise.reject(new Error('unauthorized')), staleNever),
    ).rejects.toThrow('unauthorized');
  });

  it('rethrows when there is no stale copy at all', async () => {
    const cache = new TtlCache(60);
    await expect(
      cache.getOrLoad('k', () => Promise.reject(new Error('boom')), staleOnAny),
    ).rejects.toThrow('boom');
  });

  it('coalesces concurrent misses into a single loader call', async () => {
    const cache = new TtlCache(60, () => 0);
    let calls = 0;
    const gate = deferred<string>();
    const load = () => {
      calls += 1;
      return gate.promise;
    };
    const a = cache.getOrLoad('k', load, staleNever);
    const b = cache.getOrLoad('k', load, staleNever);
    gate.resolve('shared');
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.value).toBe('shared');
    expect(rb.value).toBe('shared');
  });

  it('lets each waiter of a failed in-flight load apply its own stale fallback', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    await cache.getOrLoad('k', () => Promise.resolve('old'), staleNever);
    now = 100_000;
    const gate = deferred<string>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return gate.promise;
    };
    const a = cache.getOrLoad('k', load, staleOnAny);
    const b = cache.getOrLoad('k', load, staleNever);
    gate.reject(new Error('down'));
    await expect(a).resolves.toMatchObject({ value: 'old', stale: true });
    await expect(b).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('allows a retry after a failed load (failed promise is not cached)', async () => {
    const cache = new TtlCache(60, () => 0);
    let calls = 0;
    const load = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok');
    };
    await expect(cache.getOrLoad('k', load, staleNever)).rejects.toThrow('flaky');
    await expect(cache.getOrLoad('k', load, staleNever)).resolves.toMatchObject({ value: 'ok' });
    expect(calls).toBe(2);
  });

  it('peek() reads an entry without loading, or undefined when missing', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    expect(cache.peek('k')).toBeUndefined();
    await cache.getOrLoad('k', () => Promise.resolve('v'), staleNever);
    now = 90_000;
    expect(cache.peek('k')).toMatchObject({ value: 'v', stale: true });
  });

  it('inspect() reports keys, age and staleness without deleting entries', async () => {
    let now = 0;
    const cache = new TtlCache(60, () => now);
    await cache.getOrLoad('a', () => Promise.resolve(1), staleNever);
    now = 90_000;
    await cache.getOrLoad('b', () => Promise.resolve(2), staleNever);
    expect(cache.inspect()).toEqual([
      { key: 'a', ageSeconds: 90, stale: true },
      { key: 'b', ageSeconds: 0, stale: false },
    ]);
  });
});
