// SubrequestMeter has no upstream counterpart (platform review finding 6, coverage finding 3).
import { describe, expect, it } from 'vitest';
import { SubrequestMeter } from '../../src/canvas/budget';
import type { BudgetView } from '../../src/types';

function snapshot(meter: SubrequestMeter): Record<string, unknown> {
  return {
    limit: meter.limit,
    used: meter.used,
    remaining: meter.remaining,
    reserved: meter.reserved,
    counts: meter.counts,
  };
}

describe('SubrequestMeter', () => {
  it('starts empty', () => {
    const meter = new SubrequestMeter(40);
    expect(snapshot(meter)).toEqual({
      limit: 40,
      used: 0,
      remaining: 40,
      reserved: 0,
      counts: { canvas: 0, d1: 0, r2: 0 },
    });
  });

  it('satisfies BudgetView', () => {
    const view: BudgetView = new SubrequestMeter(6);
    expect(view.reserve(2)).toBe(true);
    expect([view.limit, view.used, view.remaining]).toEqual([6, 0, 4]);
  });

  it('counts Canvas, D1 and R2 against one limit', () => {
    const meter = new SubrequestMeter(6);
    expect(meter.take('canvas')).toBe(true);
    expect(meter.take('canvas', 2)).toBe(true);
    expect(meter.take('d1')).toBe(true);
    expect(meter.take('r2', 2)).toBe(true);
    expect(snapshot(meter)).toEqual({
      limit: 6,
      used: 6,
      remaining: 0,
      reserved: 0,
      counts: { canvas: 3, d1: 1, r2: 2 },
    });
    expect(meter.take('canvas')).toBe(false);
    expect(meter.take('d1')).toBe(false);
    expect(meter.take('r2')).toBe(false);
    expect(meter.used).toBe(6);
  });

  it('take is all-or-nothing', () => {
    const meter = new SubrequestMeter(5);
    expect(meter.take('canvas', 3)).toBe(true);
    const before = snapshot(meter);
    expect(meter.take('canvas', 3)).toBe(false);
    expect(snapshot(meter)).toEqual(before);
    expect(meter.take('canvas', 2)).toBe(true);
    expect(meter.remaining).toBe(0);
  });

  it('take never eats into reservations', () => {
    const meter = new SubrequestMeter(10);
    expect(meter.reserve(4)).toBe(true);
    expect(meter.remaining).toBe(6);
    expect(meter.take('canvas', 6)).toBe(true);
    const before = snapshot(meter);
    expect(meter.take('canvas')).toBe(false);
    expect(meter.take('d1')).toBe(false);
    expect(snapshot(meter)).toEqual(before);
    expect(meter.reserved).toBe(4);
    expect(meter.used).toBe(6);
  });

  it('reserve fails without change when free capacity is insufficient', () => {
    const meter = new SubrequestMeter(5);
    expect(meter.take('canvas', 3)).toBe(true);
    expect(meter.reserve(3)).toBe(false);
    expect(meter.reserved).toBe(0);
    expect(meter.reserve(2)).toBe(true);
    expect(meter.reserve(1)).toBe(false);
    expect(snapshot(meter)).toEqual({ limit: 5, used: 3, remaining: 0, reserved: 2, counts: { canvas: 3, d1: 0, r2: 0 } });
  });

  it('reservations accumulate', () => {
    const meter = new SubrequestMeter(10);
    expect(meter.reserve(2)).toBe(true);
    expect(meter.reserve(3)).toBe(true);
    expect(meter.reserved).toBe(5);
    expect(meter.remaining).toBe(5);
    expect(meter.used).toBe(0);
  });

  it('takeReserved consumes reserved slots first', () => {
    const meter = new SubrequestMeter(10);
    meter.reserve(3);
    expect(meter.takeReserved('d1')).toBe(true);
    expect(snapshot(meter)).toEqual({ limit: 10, used: 1, remaining: 7, reserved: 2, counts: { canvas: 0, d1: 1, r2: 0 } });
    expect(meter.takeReserved('canvas', 2)).toBe(true);
    expect(snapshot(meter)).toEqual({ limit: 10, used: 3, remaining: 7, reserved: 0, counts: { canvas: 2, d1: 1, r2: 0 } });
  });

  it('takeReserved falls back to free capacity when reservations run out', () => {
    const meter = new SubrequestMeter(10);
    meter.reserve(1);
    expect(meter.takeReserved('canvas', 3)).toBe(true);
    expect(snapshot(meter)).toEqual({ limit: 10, used: 3, remaining: 7, reserved: 0, counts: { canvas: 3, d1: 0, r2: 0 } });
    expect(meter.takeReserved('r2')).toBe(true);
    expect(meter.remaining).toBe(6);
  });

  it('takeReserved is all-or-nothing', () => {
    const meter = new SubrequestMeter(5);
    meter.reserve(2);
    meter.take('canvas', 2);
    const before = snapshot(meter);
    expect(before.remaining).toBe(1);
    expect(meter.takeReserved('d1', 4)).toBe(false);
    expect(snapshot(meter)).toEqual(before);
    expect(meter.takeReserved('d1', 3)).toBe(true);
    expect(snapshot(meter)).toEqual({ limit: 5, used: 5, remaining: 0, reserved: 0, counts: { canvas: 2, d1: 3, r2: 0 } });
    expect(meter.takeReserved('d1')).toBe(false);
  });

  it('a reserved write still fits after reads exhaust the free budget', () => {
    // The guarded-write pattern: reserve claim + write + read-back + audit, then read freely.
    const meter = new SubrequestMeter(20);
    expect(meter.reserve(4)).toBe(true);
    let reads = 0;
    while (meter.take('canvas')) reads++;
    expect(reads).toBe(16);
    expect(meter.takeReserved('d1')).toBe(true);
    expect(meter.takeReserved('canvas')).toBe(true);
    expect(meter.takeReserved('canvas')).toBe(true);
    expect(meter.takeReserved('d1')).toBe(true);
    expect(meter.takeReserved('d1')).toBe(false);
    expect(meter.used).toBe(20);
    expect(meter.counts).toEqual({ canvas: 18, d1: 2, r2: 0 });
  });

  it('never exceeds the limit, whatever the call sequence', () => {
    const meter = new SubrequestMeter(13);
    const kinds = ['canvas', 'd1', 'r2'] as const;
    let granted = 0;
    for (let i = 0; i < 500; i++) {
      const n = (i * 7) % 4;
      const kind = kinds[i % 3] ?? 'canvas';
      const before = meter.used;
      let ok: boolean;
      if (i % 5 === 0) ok = meter.reserve(n);
      else if (i % 2 === 0) ok = meter.takeReserved(kind, n);
      else ok = meter.take(kind, n);
      if (i % 5 !== 0 && ok) granted += n;
      if (!ok) expect(meter.used).toBe(before);
      expect(meter.used + meter.reserved + meter.remaining).toBe(13);
      expect(meter.remaining).toBeGreaterThanOrEqual(0);
      expect(meter.reserved).toBeGreaterThanOrEqual(0);
      expect(meter.used).toBeLessThanOrEqual(13);
    }
    expect(meter.used).toBe(granted);
    const { canvas, d1, r2 } = meter.counts;
    expect(canvas + d1 + r2).toBe(meter.used);
  });

  it('release returns unused reservations to free capacity', () => {
    const meter = new SubrequestMeter(10);
    meter.reserve(6);
    meter.release(2);
    expect([meter.reserved, meter.remaining]).toEqual([4, 6]);
    meter.release(100);
    expect([meter.reserved, meter.remaining]).toEqual([0, 10]);
    meter.reserve(3);
    meter.release();
    expect([meter.reserved, meter.remaining, meter.used]).toEqual([0, 10, 0]);
  });

  it('a zero-sized request succeeds and changes nothing', () => {
    const meter = new SubrequestMeter(0);
    expect(meter.take('canvas', 0)).toBe(true);
    expect(meter.reserve(0)).toBe(true);
    expect(meter.takeReserved('d1', 0)).toBe(true);
    expect(meter.take('canvas')).toBe(false);
    expect(snapshot(meter)).toEqual({ limit: 0, used: 0, remaining: 0, reserved: 0, counts: { canvas: 0, d1: 0, r2: 0 } });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses the invalid amount %s without throwing or changing state',
    (n) => {
      const meter = new SubrequestMeter(10);
      meter.reserve(2);
      meter.take('canvas', 1);
      const before = snapshot(meter);
      expect(meter.take('canvas', n)).toBe(false);
      expect(meter.reserve(n)).toBe(false);
      expect(meter.takeReserved('canvas', n)).toBe(false);
      meter.release(n);
      expect(snapshot(meter)).toEqual(before);
    },
  );

  it('refuses an unknown kind', () => {
    const meter = new SubrequestMeter(10);
    for (const kind of ['kv', 'toString', '__proto__', 'constructor']) {
      expect(meter.take(kind as 'canvas')).toBe(false);
      expect(meter.takeReserved(kind as 'canvas')).toBe(false);
    }
    expect(meter.used).toBe(0);
    expect(meter.counts).toEqual({ canvas: 0, d1: 0, r2: 0 });
  });

  it.each([
    [-5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [0, 0],
    [6.9, 6],
    [50, 50],
  ])('normalizes the limit %s to %i', (limit, expected) => {
    const meter = new SubrequestMeter(limit);
    expect(meter.limit).toBe(expected);
    expect(meter.remaining).toBe(expected);
  });

  it('exposes counts as a snapshot that cannot corrupt the meter', () => {
    const meter = new SubrequestMeter(5);
    meter.take('canvas');
    const counts = meter.counts as Record<string, number>;
    counts.canvas = 99;
    expect(meter.counts.canvas).toBe(1);
    expect(meter.used).toBe(1);
  });

  it('keeps state per instance', () => {
    const a = new SubrequestMeter(3);
    const b = new SubrequestMeter(3);
    a.take('canvas', 3);
    expect(b.remaining).toBe(3);
    expect(b.take('canvas', 3)).toBe(true);
  });
});
