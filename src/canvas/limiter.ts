// Replaces the module-level asyncio.Semaphore of canvas_mcp/core/client.py
// (_get_request_semaphore) with a per-call limiter whose width can change mid-call.

export interface Limiter {
  /** Run `fn` when a slot is free. Waiters start in the order they called. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Change the width. Lowering it never interrupts running tasks; it only delays the next start. */
  setMax(n: number): void;
  /** Tasks currently running. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly pending: number;
  readonly max: number;
}

function normalizeMax(n: number): number {
  return Number.isNaN(n) ? 1 : Math.max(1, Math.floor(n));
}

export function createLimiter(max: number): Limiter {
  let limit = normalizeMax(max);
  let active = 0;
  const queue: Array<() => void> = [];

  const drain = (): void => {
    while (active < limit) {
      const start = queue.shift();
      if (start === undefined) return;
      start();
    }
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          active++;
          // The slot is freed before the caller resumes, so `active` is
          // already accurate in the caller's continuation.
          const finish = (): void => {
            active--;
            drain();
          };
          let task: Promise<T>;
          try {
            task = Promise.resolve(fn());
          } catch (error) {
            task = Promise.reject(error);
          }
          task.then(
            (value) => {
              finish();
              resolve(value);
            },
            (error: unknown) => {
              finish();
              reject(error);
            },
          );
        });
        drain();
      });
    },
    setMax(n: number): void {
      limit = normalizeMax(n);
      drain();
    },
    get active(): number {
      return active;
    },
    get pending(): number {
      return queue.length;
    },
    get max(): number {
      return limit;
    },
  };
}
