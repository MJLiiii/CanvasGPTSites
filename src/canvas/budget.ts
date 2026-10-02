// No upstream counterpart: canvas-mcp runs unmetered. The Sites runtime counts
// Canvas fetches and D1/R2 calls against one subrequest cap and throws when it
// is exceeded, so every subrequest of a tool call is metered here first.
import type { BudgetView } from '../types';

export type SubrequestKind = 'canvas' | 'd1' | 'r2';

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * One meter per tool call. `remaining` is free capacity: what is neither used
 * nor set aside by `reserve`. No method throws; each returns false and changes
 * nothing when it cannot be satisfied in full.
 */
export class SubrequestMeter implements BudgetView {
  readonly #limit: number;
  #used = 0;
  #reserved = 0;
  readonly #counts: Record<SubrequestKind, number> = { canvas: 0, d1: 0, r2: 0 };

  constructor(limit: number) {
    this.#limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  get limit(): number {
    return this.#limit;
  }

  get used(): number {
    return this.#used;
  }

  /** Free capacity, excluding reservations. */
  get remaining(): number {
    return this.#limit - this.#used - this.#reserved;
  }

  /** Slots set aside and not yet consumed. */
  get reserved(): number {
    return this.#reserved;
  }

  /** Subrequests consumed so far, per kind (a snapshot). */
  get counts(): Readonly<Record<SubrequestKind, number>> {
    return { ...this.#counts };
  }

  /** Consume `n` free slots (default 1). Never touches reservations. */
  take(kind: SubrequestKind, n = 1): boolean {
    if (!isCount(n) || !Object.hasOwn(this.#counts, kind) || n > this.remaining) return false;
    this.#used += n;
    this.#counts[kind] += n;
    return true;
  }

  /** Set aside `n` free slots for later mandatory steps (write, read-back, D1). */
  reserve(n: number): boolean {
    if (!isCount(n) || n > this.remaining) return false;
    this.#reserved += n;
    return true;
  }

  /** Consume `n` slots (default 1), drawing on reservations first and free capacity for the rest. */
  takeReserved(kind: SubrequestKind, n = 1): boolean {
    if (!isCount(n) || !Object.hasOwn(this.#counts, kind)) return false;
    const fromReserved = Math.min(n, this.#reserved);
    if (n - fromReserved > this.remaining) return false;
    this.#reserved -= fromReserved;
    this.#used += n;
    this.#counts[kind] += n;
    return true;
  }

  /** Return up to `n` unused reserved slots (default: all) to free capacity. */
  release(n: number = this.#reserved): void {
    if (!isCount(n)) return;
    this.#reserved -= Math.min(n, this.#reserved);
  }
}
