// Ports src/canvas_mcp/core/dates.py.
/**
 * Date parsing and formatting utilities for Canvas API values.
 *
 * All dates are standardized to ISO 8601 with these conventions:
 * - every value includes a time component (even if it is 00:00:00)
 * - every value includes timezone information (Z for UTC or a +/-HH:MM offset)
 * - Canvas returns UTC; comparisons stay on the absolute instant
 * - user-facing output is converted to the configured timezone (default UTC)
 *   so models surface a wall-clock time the user recognizes
 * - a value without timezone information is assumed to be UTC
 *
 * Upstream reads the timezone from global config. Here it is a parameter, and
 * nothing is cached at module scope.
 */
import { PYTHON_SPACE_CLASS, pythonStrip } from './python-text';

// strptime turns a space in the format into `\s+`, with Python's meaning of `\s`.
const PY_SPACE = PYTHON_SPACE_CLASS;

// The directive patterns of Python's `_strptime`, which is more lenient than
// the format strings suggest: single-digit fields, space-padded day and hour.
const YEAR = '(?<Y>\\d{4})';
const MONTH = '(?<m>1[0-2]|0[1-9]|[1-9])';
const DAY = '(?<d>3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])';
const HOUR = '(?<H>2[0-3]|[01]\\d|\\d| \\d)';
const MINUTE = '(?<M>[0-5]\\d|\\d)';
const SECOND = '(?<S>6[01]|[0-5]\\d|\\d)';
const FRACTION = '(?<f>\\d{1,6})';
const OFFSET = '(?<z>[+-]\\d\\d:?[0-5]\\d(?::?[0-5]\\d(?:\\.\\d{1,6})?)?|Z)';
const DATE = `${YEAR}-${MONTH}-${DAY}`;
const US_DATE = `${MONTH}/${DAY}/${YEAR}`;
const TIME = `${HOUR}:${MINUTE}:${SECOND}`;

// Upstream's formats, in upstream's order. strptime matches literals
// case-insensitively, hence [Tt] and [Zz]; the Z inside %z is upper-case only.
const FORMATS: readonly RegExp[] = [
  new RegExp(`^${DATE}[Tt]${TIME}[Zz]`), // %Y-%m-%dT%H:%M:%SZ       2023-01-15T14:30:00Z
  new RegExp(`^${DATE}[Tt]${TIME}\\.${FRACTION}[Zz]`), // %Y-%m-%dT%H:%M:%S.%fZ    2023-01-15T14:30:00.000Z
  new RegExp(`^${DATE}[Tt]${TIME}${OFFSET}`), // %Y-%m-%dT%H:%M:%S%z      2023-01-15T14:30:00+0000
  new RegExp(`^${DATE}[Tt]${TIME}\\.${FRACTION}${OFFSET}`), // %Y-%m-%dT%H:%M:%S.%f%z   2023-01-15T14:30:00.000+0000
  new RegExp(`^${DATE}${PY_SPACE}+${TIME}`), // %Y-%m-%d %H:%M:%S        2023-01-15 14:30:00
  new RegExp(`^${DATE}`), // %Y-%m-%d                 2023-01-15
  new RegExp(`^${US_DATE}${PY_SPACE}+${TIME}`), // %m/%d/%Y %H:%M:%S        01/15/2023 14:30:00
  new RegExp(`^${US_DATE}`), // %m/%d/%Y                 01/15/2023
];

const SECONDS_PER_DAY = 86400;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Days from 1970-01-01 to the given proleptic Gregorian date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The result of `parseDate`: a `Date` for the absolute instant (so it compares
 * and sorts like any Date), which also remembers the wall-clock fields and UTC
 * offset the input carried, as Python's aware `datetime` does.
 */
export class ParsedDate extends Date {
  /** UTC offset the input carried, in whole seconds; 0 for `Z` and for values without an offset. */
  readonly utcOffsetSeconds: number;
  /** Sub-second part of the wall-clock time, 0 to 999999. */
  readonly microsecond: number;
  private readonly wallClock: WallClock;
  private readonly offsetMicroseconds: number;

  constructor(wallClock: WallClock, microsecond: number, utcOffsetSeconds: number, offsetMicroseconds: number) {
    const seconds =
      daysFromCivil(wallClock.year, wallClock.month, wallClock.day) * SECONDS_PER_DAY +
      wallClock.hour * 3600 +
      wallClock.minute * 60 +
      wallClock.second -
      utcOffsetSeconds;
    super(seconds * 1000 + Math.floor((microsecond - offsetMicroseconds) / 1000));
    this.wallClock = wallClock;
    this.microsecond = microsecond;
    this.utcOffsetSeconds = utcOffsetSeconds;
    this.offsetMicroseconds = offsetMicroseconds;
  }

  /**
   * Python's `datetime.isoformat()` for the parsed value: the wall-clock time
   * with its own offset, e.g. `2026-01-26T23:59:00+00:00`. UTC is written as
   * `+00:00`, never `Z`; microseconds appear only when non-zero.
   */
  isoformat(): string {
    const w = this.wallClock;
    let out = `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}T${pad(w.hour, 2)}:${pad(w.minute, 2)}:${pad(w.second, 2)}`;
    if (this.microsecond !== 0) out += `.${pad(this.microsecond, 6)}`;
    return out + formatOffset(this.utcOffsetSeconds, this.offsetMicroseconds);
  }
}

/** `+HH:MM`, extended by `:SS` and `.ffffff` only when the offset has those parts (as Python prints it). */
function formatOffset(offsetSeconds: number, offsetMicroseconds = 0): string {
  const sign = offsetSeconds < 0 || offsetMicroseconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const seconds = abs % 60;
  let out = `${sign}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor((abs % 3600) / 60), 2)}`;
  if (seconds !== 0 || offsetMicroseconds !== 0) out += `:${pad(seconds, 2)}`;
  if (offsetMicroseconds !== 0) out += `.${pad(Math.abs(offsetMicroseconds), 6)}`;
  return out;
}

/** Offset in [seconds, microseconds] for a `%z` match, or null where strptime raises. */
function parseOffset(raw: string): [number, number] | null {
  if (raw === 'Z') return [0, 0];
  let z = raw;
  if (z[3] === ':') {
    z = z.slice(0, 3) + z.slice(4);
    if (z.length > 5) {
      // "Inconsistent use of :" upstream.
      if (z[5] !== ':') return null;
      z = z.slice(0, 5) + z.slice(6);
    }
  }
  const secondsText = z.slice(5, 7);
  if (secondsText !== '' && !/^\d\d$/.test(secondsText)) return null;
  const hours = Number(z.slice(1, 3));
  const minutes = Number(z.slice(3, 5));
  let seconds = hours * 3600 + minutes * 60 + (secondsText === '' ? 0 : Number(secondsText));
  let microseconds = Number(z.slice(8).padEnd(6, '0'));
  // Python's timezone() accepts only offsets strictly inside +/-24 hours.
  if (seconds >= SECONDS_PER_DAY) return null;
  if (z.startsWith('-')) {
    seconds = -seconds;
    microseconds = -microseconds;
  }
  return [seconds, microseconds];
}

/**
 * Parse a date string.
 *
 * Tries upstream's formats in upstream's order. Timezone information is
 * preserved when present; otherwise UTC is assumed. Returns null if no format
 * fits or the fields do not name a real date.
 */
export function parseDate(dateStr: string | null | undefined): ParsedDate | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const text = pythonStrip(dateStr);

  for (const format of FORMATS) {
    const match = format.exec(text);
    // strptime takes the first match of the pattern and then rejects leftover text.
    if (match === null || match[0].length !== text.length) continue;
    const groups = match.groups ?? {};

    const wallClock: WallClock = {
      year: Number(groups.Y),
      month: Number(groups.m),
      day: Number(groups.d),
      hour: groups.H === undefined ? 0 : Number(groups.H),
      minute: groups.M === undefined ? 0 : Number(groups.M),
      second: groups.S === undefined ? 0 : Number(groups.S),
    };
    if (wallClock.year < 1) continue;
    if (wallClock.day > daysInMonth(wallClock.year, wallClock.month)) continue;
    // %S admits leap seconds 60 and 61, which datetime then rejects.
    if (wallClock.second > 59) continue;

    const microsecond = groups.f === undefined ? 0 : Number(groups.f.padEnd(6, '0'));
    const offset = groups.z === undefined ? ([0, 0] as [number, number]) : parseOffset(groups.z);
    if (offset === null) continue;
    return new ParsedDate(wallClock, microsecond, offset[0], offset[1]);
  }

  // Upstream prints the unparseable string to stderr here. The port does not:
  // the value is Canvas data or tool input, which is kept out of logs.
  return null;
}

/** True when `formatDate` would honour `name`: empty (the UTC default), UTC, or an IANA zone the runtime knows. */
export function isValidTimeZone(name: string | null | undefined): boolean {
  const zone = (name ?? '').trim();
  if (zone === '' || zone.toUpperCase() === 'UTC') return true;
  return zoneFormatter(zone) !== null;
}

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
}

/** Wall-clock fields of the instant `epochSeconds` in the formatter's zone, plus that zone's offset then. */
function zoneWallClock(formatter: Intl.DateTimeFormat, epochSeconds: number): WallClock & { offsetSeconds: number } {
  const fields: Record<string, number> = {};
  let beforeCommonEra = false;
  for (const part of formatter.formatToParts(new Date(epochSeconds * 1000))) {
    if (part.type === 'era') beforeCommonEra = part.value.startsWith('B');
    else if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const year = beforeCommonEra ? 1 - (fields.year ?? 0) : (fields.year ?? 0);
  const wallClock: WallClock = {
    year,
    month: fields.month ?? 1,
    day: fields.day ?? 1,
    hour: fields.hour ?? 0,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0,
  };
  const asUtc =
    daysFromCivil(wallClock.year, wallClock.month, wallClock.day) * SECONDS_PER_DAY +
    wallClock.hour * 3600 +
    wallClock.minute * 60 +
    wallClock.second;
  return { ...wallClock, offsetSeconds: asUtc - epochSeconds };
}

function utcWallClock(epochSeconds: number): WallClock & { offsetSeconds: number } {
  const days = Math.floor(epochSeconds / SECONDS_PER_DAY);
  const rest = epochSeconds - days * SECONDS_PER_DAY;
  return {
    ...civilFromDays(days),
    hour: Math.floor(rest / 3600),
    minute: Math.floor((rest % 3600) / 60),
    second: rest % 60,
    offsetSeconds: 0,
  };
}

export type DateFormatter = (value: string | null | undefined) => string;

/**
 * Build a `formatDate` bound to one timezone. Resolving a zone is the costly
 * part, so a tool that formats many dates should build this once per call.
 *
 * An empty, missing or unknown zone means UTC. Upstream warns on stderr for an
 * unknown zone; here the warning belongs to config validation (see
 * `isValidTimeZone`), so formatting stays silent.
 */
export function createDateFormatter(timezone?: string | null): DateFormatter {
  const zone = (timezone ?? '').trim();
  const formatter = zone === '' || zone.toUpperCase() === 'UTC' ? null : zoneFormatter(zone);

  return (value) => {
    if (!value) return 'N/A';
    if (typeof value !== 'string') return String(value);

    const parsed = parseDate(value);
    if (parsed === null) return value; // Return original if parsing fails

    const epochSeconds = Math.floor(parsed.getTime() / 1000);
    // Python's datetime covers years 1 to 9999 and upstream raises when the
    // instant, in UTC or in the output zone, falls outside that range. The
    // original text is the safer answer.
    const utc = utcWallClock(epochSeconds);
    if (utc.year < 1 || utc.year > 9999) return value;
    const local = formatter === null ? utc : zoneWallClock(formatter, epochSeconds);
    if (local.year < 1 || local.year > 9999) return value;

    const iso = `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}T${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.second, 2)}`;
    // UTC keeps the historical Z suffix; other zones use a numeric offset.
    return local.offsetSeconds === 0 ? `${iso}Z` : iso + formatOffset(local.offsetSeconds);
  };
}

/**
 * Format a date string as ISO 8601 (to the second) in the given IANA timezone.
 *
 * UTC is rendered with the `Z` suffix; other zones use a numeric offset
 * (e.g. `2026-05-28T18:59:59-05:00`). Returns "N/A" for an empty value and the
 * input unchanged when it cannot be parsed.
 */
export function formatDate(value: string | null | undefined, timezone?: string | null): string {
  return createDateFormatter(timezone)(value);
}

/** Truncate text to a maximum length (in code points, as Python counts) and add an ellipsis if needed. */
export function truncateText(text: string, maxLength = 100): string {
  if (!text || text.length <= maxLength) return text;
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  // slice() treats a negative end the way Python's text[:n] does.
  return `${chars.slice(0, maxLength - 3).join('')}...`;
}
