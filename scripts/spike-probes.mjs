// Credential-free M0 checks, with an optional Sites bypass credential supplied
// through hidden stdin. Never accepts a Canvas token or prints credentials.
import { writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Node's fetch adds Sec-Fetch-Mode: cors. Use the HTTP client so these probes
// model server-to-server MCP traffic rather than the intentionally refused browser path.
function exchange(url, options, body) {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, options, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2_200_000) { request.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode,
        contentType: response.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.setTimeout(35_000, () => request.destroy(new Error('Probe timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

async function readInput() {
  console.log('Ready for spike JSON on stdin (input is hidden).');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk;
      if (text.length > 16_384) { finish(); reject(new Error('Input too large')); return; }
      if (!text.includes('\n')) return;
      finish();
      try { resolve(JSON.parse(text.trim())); } catch { reject(new Error('Invalid input')); }
    };
    function finish() {
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdin.on('data', onData);
  });
}

const input = await readInput();
const base = new URL(input.siteUrl);
if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
  throw new Error('Invalid Site origin');
}
const fake = { 'oai-authenticated-user-email': input.ownerEmail ?? 'forged-owner@example.invalid',
  'oai-authenticated-user-id': 'forged-spike-user' };
const bypass = input.bypassToken ? { 'OAI-Sites-Authorization': `Bearer ${input.bypassToken}` } : {};
const results = [];
let id = 0;

async function check(label, path, headers, method, params, verb = 'POST') {
  const started = Date.now();
  try {
    const response = await exchange(new URL(path, base), {
      method: verb,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    }, verb === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) : undefined);
    const row = { label, status: response.status, contentType: response.contentType, ms: Date.now() - started };
    const body = response.body;
    try {
      const json = JSON.parse(body);
      if (json.error) row.rpcError = { code: json.error.code };
      if (json.private === true) row.private = true;
      if (json.result?.protocolVersion) row.protocolVersion = json.result.protocolVersion;
      if (json.result?.tools) row.tools = json.result.tools.map((tool) => tool.name);
      if (json.result?.structuredContent) {
        const value = json.result.structuredContent;
        if (Array.isArray(value.headers)) {
          value.headers = value.headers.map(({ name, length }) => ({ name, length }));
        }
        row.probe = value;
      }
      if (json.result?.content) {
        row.isError = json.result.isError === true;
        row.resultBytes = new TextEncoder().encode(JSON.stringify(json.result)).length;
      }
    } catch { /* A gateway redirect or HTML error is identified by status and content type only. */ }
    results.push(row);
  } catch (error) { results.push({ label, error: error instanceof Error ? error.name : 'UnknownError' }); }
}

const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'canvas-sites-spike', version: '1' } };
await check('anonymous initialize', '/mcp', {}, 'initialize', init);
await check('anonymous forged identity', '/mcp', fake, 'tools/call', { name: 'sites_diagnostics', arguments: { probe: 'headers' } });
await check('anonymous forged status', '/api/status', fake, undefined, undefined, 'GET');
if (input.bypassToken) {
  await check('bypass initialize', '/mcp', bypass, 'initialize', init);
  await check('bypass discovery', '/mcp', bypass, 'tools/list');
  await check('bypass forged identity', '/mcp', { ...bypass, ...fake }, 'tools/call', { name: 'sites_diagnostics', arguments: { probe: 'headers' } });
  await check('bypass duplicate identity', '/mcp', { ...bypass, ...fake,
    'oai-authenticated-user-email': `${fake['oai-authenticated-user-email']}, visitor@example.invalid` },
    'tools/call', { name: 'sites_diagnostics', arguments: { probe: 'headers' } });
  await check('bypass forged status', '/api/status', { ...bypass, ...fake }, undefined, undefined, 'GET');
  await check('bypass forged browser', '/mcp', { ...bypass, ...fake, origin: base.origin, 'sec-fetch-mode': 'cors' },
    'tools/call', { name: 'hello', arguments: {} });
  for (const [probe, n] of [['runtime', undefined], ['d1', 60], ['subrequests', 60], ['cpu', 50], ['wall', 1000], ['size', 100000]]) {
    await check(`bypass ${probe}`, '/mcp', bypass, 'tools/call', { name: 'sites_diagnostics', arguments: { probe, ...(n !== undefined && { n }) } });
  }
}
if (input.localRuntime === true) {
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('Local runtime probes require a loopback HTTP origin');
  }
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'canvas-sites-spike', version: '1' },
  };
  const headers = { 'mcp-protocol-version': '2026-07-28' };
  await check('local modern discovery without routing headers', '/mcp', headers, 'server/discover', { _meta: meta });
  for (const [probe, n] of [['runtime', undefined], ['d1', 60], ['cpu', 50], ['wall', 1000], ['size', 100000]]) {
    await check(`local modern ${probe}`, '/mcp', headers, 'tools/call', {
      _meta: meta, name: 'sites_diagnostics', arguments: { probe, ...(n !== undefined && { n }) },
    });
  }
  await check('local browser rejection', '/mcp', { ...headers, origin: base.origin, 'sec-fetch-mode': 'cors' },
    'tools/call', { _meta: meta, name: 'hello', arguments: {} });
}
if (input.outputPath) await writeFile(input.outputPath, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
