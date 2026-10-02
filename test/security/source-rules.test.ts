// No upstream counterpart: pins the rules of AGENTS.md that a type checker cannot see, by reading the source text.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

interface Source {
  /** Path under src/, with forward slashes. */
  name: string;
  text: string;
  /** The text with comments removed, so prose about a rule is not mistaken for a breach of it. */
  code: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES: Source[] = sourceFiles(SRC).map((file) => {
  const text = readFileSync(file, 'utf8');
  return { name: relative(SRC, file).split(sep).join('/'), text, code: stripComments(text) };
});

function filesMatching(pattern: RegExp): string[] {
  return SOURCES.filter((source) => pattern.test(source.code)).map((source) => source.name);
}

describe('runtime independence', () => {
  it('finds the source tree', () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(SOURCES.map((source) => source.name)).toContain('canvas/path.ts');
  });

  it('imports nothing from node:* or cloudflare:*', () => {
    expect(filesMatching(/(?:from|import|require)\s*\(?\s*['"](?:node|cloudflare):/)).toEqual([]);
  });

  it('never reads process.env', () => {
    expect(filesMatching(/\bprocess\s*\.\s*env\b/)).toEqual([]);
  });
});

describe('type seams', () => {
  it('has no cast that silences the checker', () => {
    expect(filesMatching(/\bas\s+any\b|\bas\s+unknown\s+as\b|@ts-ignore|@ts-expect-error|@ts-nocheck/)).toEqual([]);
  });
});

describe('Canvas paths', () => {
  // rawCanvasPath brands a path without encoding anything, so it must never be
  // given an identifier. Its callers are pinned here: adding one means showing
  // in this test that its argument is a constant.
  it('rawCanvasPath is called only with a string constant, and only by the Canvas client', () => {
    const calls: Array<{ file: string; call: string }> = [];
    for (const source of SOURCES) {
      if (source.name === 'canvas/path.ts') continue;
      for (const match of source.code.matchAll(/\brawCanvasPath\s*\(([^)]*)\)/g)) {
        calls.push({ file: source.name, call: (match[1] ?? '').trim() });
      }
    }
    expect(calls).toEqual([{ file: 'canvas/client.ts', call: "'/courses'" }]);
  });

  it('rawCanvasPath is not passed around under another name', () => {
    const importers = SOURCES.filter(
      (source) => source.name !== 'canvas/path.ts' && /\brawCanvasPath\b/.test(source.code),
    ).map((source) => source.name);
    expect(importers).toEqual(['canvas/client.ts']);
    const client = SOURCES.find((source) => source.name === 'canvas/client.ts') as Source;
    // One import and one call; any third mention would be an alias or a re-export.
    expect(client.code.match(/\brawCanvasPath\b/g)).toHaveLength(2);
  });

  it('no module builds a request path by concatenating into a CanvasPath cast', () => {
    const offenders = SOURCES.filter(
      (source) => source.name !== 'canvas/path.ts' && /\bas\s+CanvasPath\b/.test(source.code),
    ).map((source) => source.name);
    expect(offenders).toEqual([]);
  });
});

describe('tool modules', () => {
  const tools = SOURCES.filter((source) => source.name.startsWith('tools/'));

  it('exist', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it('never import the anonymizer: anonymization is applied inside the Canvas client only', () => {
    const offenders = tools.filter((source) => /['"][^'"]*core\/anonymization(?:-tiers)?['"]/.test(source.code));
    expect(offenders.map((source) => source.name)).toEqual([]);
  });

  it('never import the env parser, the credential providers or the Canvas client implementation', () => {
    const forbidden = /['"](?:\.\.\/)+(?:env|auth\/[^'"]+|canvas\/client|app)['"]/;
    expect(tools.filter((source) => forbidden.test(source.code)).map((source) => source.name)).toEqual([]);
  });

  it('never name the Env or Secrets types', () => {
    const offenders = tools.filter((source) => /\b(?:Env|Secrets|CanvasCredential)\b/.test(source.code));
    expect(offenders.map((source) => source.name)).toEqual([]);
  });
});

describe('the Canvas client is injected, not imported', () => {
  it('only the app imports createCanvasClient', () => {
    const importers = SOURCES.filter(
      (source) => source.name !== 'canvas/client.ts' && /\bcreateCanvasClient\b/.test(source.code),
    ).map((source) => source.name);
    expect(importers).toEqual(['app.ts']);
  });
});
