// Covers the download half of canvas_mcp/tools/files.py (read_course_file streaming and
// size cap), with redirects followed by hand as security review finding 13 requires.
import { describe, expect, it } from 'vitest';
import { isFailure, notDispatched } from '../../src/canvas/errors';
import { FILE_TOO_LARGE_ERROR, MAX_DOWNLOAD_REDIRECTS, downloadFile, isFileTooLarge } from '../../src/canvas/files';
import type { DownloadTransport } from '../../src/canvas/files';
import type { DownloadedFile, RequestFailure } from '../../src/types';
import { FAKE_TOKEN, createFakeCanvas, createTestClient } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.edu';
const CDN = 'https://inst-fs.example.net';
const FILE_URL = `${ORIGIN}/files/55/download?download_frd=1&verifier=abc123`;

function setup(options: Parameters<typeof createTestClient>[1] = {}) {
  const fake = createFakeCanvas({ origin: ORIGIN });
  return { fake, ...createTestClient(fake, options) };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function file(body: string | Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/pdf', ...headers } });
}

/** A body delivered in chunks with no Content-Length, as a chunked download is. */
function chunked(chunks: Uint8Array[], onCancel?: () => void): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
}

function failureOf(value: unknown): RequestFailure {
  if (!isFailure(value)) throw new Error('expected a failure');
  return value;
}

function fileOf(value: DownloadedFile | RequestFailure): DownloadedFile {
  if (isFailure(value)) throw new Error(`expected a file, got failure: ${value.error}`);
  return value;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('downloadFile through the client', () => {
  it('downloads from the Canvas origin with Authorization', async () => {
    const { fake, client, meter } = setup();
    fake.route('GET', '/files/55/download', () => file('%PDF-1.7 hello'));

    const result = fileOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(text(result.bytes)).toBe('%PDF-1.7 hello');
    expect(result.contentType).toBe('application/pdf');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe(FILE_URL);
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(fake.calls[0]!.redirect).toBe('manual');
    expect(meter.used).toBe(1);
  });

  it('follows a redirect to another origin without Authorization, one budget slot per hop', async () => {
    const { fake, client, meter } = setup();
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/blob/9?sig=xyz`));
    fake.route('GET', `${CDN}/blob/9`, () => file('content'));

    const result = fileOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(text(result.bytes)).toBe('content');
    expect(fake.calls.map((call) => call.url)).toEqual([FILE_URL, `${CDN}/blob/9?sig=xyz`]);
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(fake.calls[1]!.headers.authorization).toBeUndefined();
    expect(fake.calls.every((call) => call.redirect === 'manual')).toBe(true);
    expect(meter.used).toBe(2);
  });

  it('keeps Authorization on a redirect that stays on the Canvas origin', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => redirect('/courses/1/files/55/download?verifier=abc123'));
    fake.route('GET', '/courses/1/files/55/download', () => file('content'));

    fileOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(fake.calls[1]!.url).toBe(`${ORIGIN}/courses/1/files/55/download?verifier=abc123`);
    expect(fake.calls[1]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('never re-attaches Authorization after leaving the Canvas origin, even back on Canvas', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/bounce`));
    fake.route('GET', `${CDN}/bounce`, () => redirect(`${ORIGIN}/api/v1/users/self/profile`));
    fake.route('GET', '/api/v1/users/self/profile', () => file('{"name":"owner"}'));

    await client.downloadFile(FILE_URL, { maxBytes: 1_000 });

    expect(fake.calls.map((call) => call.url)).toEqual([
      FILE_URL,
      `${CDN}/bounce`,
      `${ORIGIN}/api/v1/users/self/profile`,
    ]);
    expect(fake.calls.map((call) => call.headers.authorization)).toEqual([
      `Bearer ${FAKE_TOKEN}`,
      undefined,
      undefined,
    ]);
  });

  it.each([
    ['another host', `${CDN}/files/55/download`],
    ['plain http', 'http://canvas.example.edu/files/55/download'],
    ['another port', 'https://canvas.example.edu:8443/files/55/download'],
    ['userinfo', 'https://user:pw@canvas.example.edu/files/55/download'],
    ['a lookalike host', 'https://canvas.example.edu.evil.example/files/55/download'],
    ['a relative URL', '/files/55/download'],
    ['not a URL', 'not a url'],
    ['an empty string', ''],
  ])('refuses a first hop on %s without sending anything', async (_what, url) => {
    const { fake, client, meter } = setup();

    const failure = failureOf(await client.downloadFile(url, { maxBytes: 1_000 }));

    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
    expect(meter.used).toBe(0);
  });

  it.each([
    'http://inst-fs.example.net/blob/9',
    'ftp://inst-fs.example.net/blob/9',
    'https://user:pw@inst-fs.example.net/blob/9',
    'http://canvas.example.edu/files/55/download',
  ])('refuses the redirect target %s', async (location) => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => redirect(location));

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toBe('Redirect to a location that is not plain https was refused');
    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(1);
  });

  it('fails on a redirect without a Location header', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => new Response(null, { status: 302 }));

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toBe('Redirect without Location header');
    expect(fake.calls).toHaveLength(1);
  });

  it(`follows at most ${MAX_DOWNLOAD_REDIRECTS} redirects`, async () => {
    const { fake, client, meter } = setup();
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/hop/1`));
    for (let hop = 1; hop <= 10; hop++) {
      fake.route('GET', `${CDN}/hop/${hop}`, () => redirect(`${CDN}/hop/${hop + 1}`, hop % 2 === 0 ? 307 : 301));
    }

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toMatch(/^Too many redirects/);
    expect(fake.calls).toHaveLength(MAX_DOWNLOAD_REDIRECTS + 1);
    expect(meter.used).toBe(MAX_DOWNLOAD_REDIRECTS + 1);
  });

  it('accepts a file reached on the last allowed redirect', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/hop/1`));
    fake.route('GET', `${CDN}/hop/1`, () => redirect(`${CDN}/hop/2`));
    fake.route('GET', `${CDN}/hop/2`, () => redirect(`${CDN}/hop/3`));
    fake.route('GET', `${CDN}/hop/3`, () => file('made it'));

    expect(text(fileOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 })).bytes)).toBe('made it');
  });

  it('stops when the budget runs out between hops', async () => {
    const { fake, client } = setup({ budget: 1 });
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/blob/9`));
    fake.route('GET', `${CDN}/blob/9`, () => file('content'));

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.budgetExhausted).toBe(true);
    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(1);
  });

  it('sends nothing after the deadline', async () => {
    const { fake, client, clock } = setup({ deadlineIn: 500 });
    clock.now += 500;

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
  });

  it('checks Content-Length before reading the body', async () => {
    const { fake, client } = setup();
    let cancelled = false;
    fake.route('GET', '/files/55/download', () => {
      const response = chunked([new Uint8Array(10)], () => {
        cancelled = true;
      });
      return new Response(response.body, { status: 200, headers: { 'Content-Length': '5000001' } });
    });

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 5_000_000 }));

    expect(failure.error).toBe(`${FILE_TOO_LARGE_ERROR} of 5000000 bytes`);
    expect(isFileTooLarge(failure)).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('counts bytes while streaming and aborts when the limit is passed', async () => {
    const { fake, client } = setup();
    let cancelled = false;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(40));
    fake.route('GET', '/files/55/download', () =>
      chunked(chunks, () => {
        cancelled = true;
      }),
    );

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 100 }));

    expect(isFileTooLarge(failure)).toBe(true);
    // Stopped at the third chunk; the other 97 were never pulled to completion.
    expect(cancelled).toBe(true);
  });

  it('does not trust a Content-Length that understates the body', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => {
      const response = chunked([new Uint8Array(60), new Uint8Array(60)]);
      return new Response(response.body, { status: 200, headers: { 'Content-Length': '10' } });
    });

    expect(isFileTooLarge(failureOf(await client.downloadFile(FILE_URL, { maxBytes: 100 })))).toBe(true);
  });

  it('accepts a file of exactly maxBytes and joins its chunks in order', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () =>
      chunked([new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6])]),
    );

    const result = fileOf(await client.downloadFile(FILE_URL, { maxBytes: 6 }));

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.contentType).toBe('application/octet-stream');
  });

  it('returns an empty file for an empty body and a default content type', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => new Response(null, { status: 200 }));

    const result = fileOf(await client.downloadFile(FILE_URL, { maxBytes: 0 }));

    expect(result.bytes.byteLength).toBe(0);
    expect(result.contentType).toBe('application/octet-stream');
  });

  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [404, 'rejected'],
    [500, 'may_have_written'],
    [304, 'may_have_written'],
  ] as const)('reports HTTP %i by status only', async (status, outcome) => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => redirect(`${CDN}/blob/9`));
    fake.route('GET', `${CDN}/blob/9`, () =>
      new Response(status === 304 ? null : 'third-party error page', { status }),
    );

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toBe(`HTTP error: ${status}`);
    expect(failure.status).toBe(status);
    expect(failure.outcome).toBe(outcome);
  });

  it('reports a network error without the URL query', async () => {
    const { fake, client, logLines } = setup();
    fake.route('GET', '/files/55/download', () => {
      throw new TypeError(`fetch failed for ${FILE_URL}`);
    });

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toBe(`Request failed: TypeError: fetch failed for ${ORIGIN}/files/***/download`);
    expect(JSON.stringify([failure, logLines])).not.toContain('abc123');
  });

  it('reports a body that breaks mid-stream as a failure', async () => {
    const { fake, client } = setup();
    fake.route('GET', '/files/55/download', () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(stream, { status: 200 });
    });

    const failure = failureOf(await client.downloadFile(FILE_URL, { maxBytes: 1_000 }));

    expect(failure.error).toBe('Request failed: TypeError: terminated');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the size limit %s', async (maxBytes) => {
    const { fake, client } = setup();
    expect(failureOf(await client.downloadFile(FILE_URL, { maxBytes })).outcome).toBe('not_dispatched');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('downloadFile with a stub transport', () => {
  function transport(responses: Array<Response | RequestFailure>, canvasOrigin: string | null = ORIGIN) {
    const sent: Array<{ url: string; withAuth: boolean }> = [];
    const stub: DownloadTransport = {
      canvasOrigin,
      send: async (url, withAuth) => {
        sent.push({ url: url.href, withAuth });
        return responses.shift() ?? new Response('unexpected', { status: 500 });
      },
      failure: () => notDispatched('stream failed'),
    };
    return { sent, stub };
  }

  it('asks for Authorization only while every hop so far stayed on the Canvas origin', async () => {
    const { sent, stub } = transport([
      redirect(`${ORIGIN}/second`),
      redirect(`${CDN}/third`),
      redirect(`${ORIGIN}/fourth`),
      file('done'),
    ]);

    fileOf(await downloadFile(`${ORIGIN}/first`, { maxBytes: 100 }, stub));

    expect(sent).toEqual([
      { url: `${ORIGIN}/first`, withAuth: true },
      { url: `${ORIGIN}/second`, withAuth: true },
      { url: `${CDN}/third`, withAuth: false },
      { url: `${ORIGIN}/fourth`, withAuth: false },
    ]);
  });

  it('resolves a relative Location against the hop that sent it', async () => {
    const { sent, stub } = transport([redirect(`${CDN}/a/b`), redirect('../c?x=1'), file('done')]);

    fileOf(await downloadFile(`${ORIGIN}/first`, { maxBytes: 100 }, stub));

    expect(sent.map((hop) => hop.url)).toEqual([`${ORIGIN}/first`, `${CDN}/a/b`, `${CDN}/c?x=1`]);
    expect(sent[2]!.withAuth).toBe(false);
  });

  it('returns the transport failure of any hop', async () => {
    const refusal = notDispatched('budget', { budgetExhausted: true });
    const { stub } = transport([redirect(`${CDN}/a`), refusal]);
    expect(await downloadFile(`${ORIGIN}/first`, { maxBytes: 100 }, stub)).toBe(refusal);
  });

  it('refuses everything when the Canvas origin is unknown', async () => {
    const { sent, stub } = transport([file('x')], null);
    expect(failureOf(await downloadFile(`${ORIGIN}/first`, { maxBytes: 100 }, stub)).outcome).toBe('not_dispatched');
    expect(sent).toEqual([]);
  });
});
