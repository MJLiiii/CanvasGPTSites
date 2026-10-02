// Regression for the review finding: each hostile identifier needs a fresh budget.
// Replicates the body of
// test/security/path-injection.test.ts "no request leaves the pinned origin > for any identifier, any method, pagination and course resolution"
// and records which hostile identifiers actually produced a dispatch.
import { describe, expect, it } from 'vitest';
import { canvasPath } from '../../src/canvas/path';
import { createFakeCanvas, createTestClient, json } from '../helpers/fake-canvas';

const ORIGIN = 'https://canvas.example.com';
const HOSTILE_IDENTIFIERS = [
  '%2e%2e', '%2E%2E', '.%2E', '%2e.', 'x/%2e%2e/assignments/5', 'x/../assignments/5', '../assignments/5',
  '%2e%2e/%2e%2e/users/2', '..%2f..%2fusers%2f2', '..%5c..%5cusers', '..\\..\\users', '123/submissions/456?',
  '123/submissions/456#', '123%2Fsubmissions%2F456?', 'x?include[]=user', 'x#fragment', 'x;param',
  '//evil.example/x', 'https://evil.example/x', '@evil.example',
  'x/%2e%2e/%2e%2e/assignments/2/submissions/self/%2e%2e/456',
];

describe('review: path-injection coverage has a separate budget per identifier', () => {
  it('actually dispatches all identifiers with the default test budget (40)', async () => {
    const fake = createFakeCanvas({ origin: ORIGIN });
    const secret = { id: 456, user_id: 999, name: 'Victim Realname', body: 'private submission text' };
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) fake.route(method, /.*/, () => json(secret));
    fake.route('GET', '/api/v1/courses', () => json([{ id: 1, course_code: 'CS 101' }]));

    const perIdentifier: Array<[string, number]> = [];
    for (const id of HOSTILE_IDENTIFIERS) {
      const { client, meter } = createTestClient(fake);
      const before = fake.calls.length;
      await client.request('get', canvasPath`/courses/${id}/pages/${id}`);
      await client.request('post', canvasPath`/courses/${id}/pages`, { data: { id } });
      await client.request('put', canvasPath`/courses/${id}`, { useFormData: true, data: { id } });
      await client.request('delete', canvasPath`/courses/${1}/pages/${id}`);
      await client.fetchAll(canvasPath`/courses/${id}/users`, { search_term: id });
      await client.courses.resolveCode(id);
      const resolved = await client.courses.resolveId(id);
      if (typeof resolved === 'string') await client.request('get', canvasPath`/courses/${resolved}`);
      await client.downloadFile(id, { maxBytes: 10 });
      perIdentifier.push([id, fake.calls.length - before]);
      expect(meter.remaining).toBeGreaterThan(0);
    }
    const never = perIdentifier.filter(([, n]) => n === 0).map(([id]) => id);
    // The original test's only volume assertion:
    expect(fake.calls.length).toBeGreaterThan(HOSTILE_IDENTIFIERS.length);
    expect(never.length).toBe(0);
  });
});
