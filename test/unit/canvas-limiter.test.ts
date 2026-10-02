// Ports test_concurrent_requests_obey_semaphore_cap from tests/core/test_client_state_machine.py
// and covers what the per-call limiter adds: FIFO order and a width that changes mid-call.
import { describe, expect, it } from 'vitest';
import { createLimiter } from '../../src/canvas/limiter';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('createLimiter', () => {
  it('concurrent requests obey the cap', async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
    expect(results).toEqual(Array.from({ length: 20 }, (_unused, i) => i));
  });

  it('starts a task synchronously when a slot is free', () => {
    const limiter = createLimiter(1);
    let started = false;
    void limiter.run(async () => {
      started = true;
    });
    expect(started).toBe(true);
    expect(limiter.active).toBe(1);
  });

  it('starts waiters in FIFO order', async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred());
    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        order.push(i);
        await gate.promise;
      }),
    );
    expect(order).toEqual([0]);
    expect(limiter.pending).toBe(4);
    // Release out of order: only the running task's gate matters.
    for (const i of [4, 3, 2, 1, 0]) gates[i]?.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('a later arrival cannot overtake the queue', async () => {
    const limiter = createLimiter(1);
    const order: string[] = [];
    const first = deferred();
    const a = limiter.run(async () => {
      order.push('a');
      await first.promise;
    });
    const b = limiter.run(async () => {
      order.push('b');
    });
    first.resolve();
    // Queued in the same tick that the slot frees.
    const c = limiter.run(async () => {
      order.push('c');
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('returns the value and frees the slot before the caller resumes', async () => {
    const limiter = createLimiter(1);
    const value = await limiter.run(async () => 42);
    expect(value).toBe(42);
    expect(limiter.active).toBe(0);
  });

  it('propagates a rejection and frees the slot', async () => {
    const limiter = createLimiter(1);
    const boom = new Error('boom');
    await expect(limiter.run(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(limiter.active).toBe(0);
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('turns a synchronous throw into a rejection and frees the slot', async () => {
    const limiter = createLimiter(1);
    const run = limiter.run((): Promise<never> => {
      throw new TypeError('sync');
    });
    await expect(run).rejects.toThrow('sync');
    expect(limiter.active).toBe(0);
    await expect(limiter.run(async () => 1)).resolves.toBe(1);
  });

  it('a failing task does not stall the queue', async () => {
    const limiter = createLimiter(2);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 9 }, (_unused, i) =>
        limiter.run(async () => {
          await Promise.resolve();
          if (i % 3 === 0) throw new Error(`fail ${i}`);
          return i;
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('setMax lowers concurrency mid-call without interrupting running tasks', async () => {
    const limiter = createLimiter(3);
    const gates = Array.from({ length: 6 }, () => deferred());
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
      }),
    );
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(3);

    limiter.setMax(1);
    expect(limiter.max).toBe(1);
    expect(limiter.active).toBe(3);

    // Two finish: still one running, which already fills the new width.
    gates[0]?.resolve();
    gates[1]?.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(1);

    gates[2]?.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(1);

    gates[3]?.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[4]?.resolve();
    gates[5]?.resolve();
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(limiter.active).toBe(0);
  });

  it('setMax raises concurrency and starts waiters at once, in order', async () => {
    const limiter = createLimiter(1);
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
      }),
    );
    expect(started).toEqual([0]);
    limiter.setMax(3);
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(3);
    expect(limiter.pending).toBe(2);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('a task can lower the width itself, as the client does when quota runs low', async () => {
    const limiter = createLimiter(4);
    let active = 0;
    const peaks: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_unused, i) =>
        limiter.run(async () => {
          active++;
          if (i === 0) {
            // Let the other three slots fill, as they would while a response is in flight.
            await Promise.resolve();
            limiter.setMax(1);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          peaks[i] = active;
          active--;
        }),
      ),
    );
    // The first four were already running; everything after runs alone.
    expect(Math.max(...peaks.slice(0, 4))).toBe(4);
    expect(peaks.slice(4).every((peak) => peak === 1)).toBe(true);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [2.9, 2],
    [4, 4],
  ])('normalizes a max of %s to %i', (max, expected) => {
    expect(createLimiter(max).max).toBe(expected);
    const limiter = createLimiter(3);
    limiter.setMax(max);
    expect(limiter.max).toBe(expected);
  });

  it('supports nested runs up to the width without deadlock', async () => {
    const limiter = createLimiter(2);
    const value = await limiter.run(() => limiter.run(async () => 'inner'));
    expect(value).toBe('inner');
    expect(limiter.active).toBe(0);
  });

  it('keeps state per instance', async () => {
    const a = createLimiter(1);
    const b = createLimiter(1);
    const gate = deferred();
    const blocked = a.run(() => gate.promise);
    await expect(b.run(async () => 'free')).resolves.toBe('free');
    expect(a.active).toBe(1);
    expect(b.active).toBe(0);
    gate.resolve();
    await blocked;
  });
});
