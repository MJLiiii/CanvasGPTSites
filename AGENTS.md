# Working in this repository

This is a TypeScript port of the Python MCP server canvas-mcp, built to run as a Cloudflare Worker hosted on ChatGPT Sites.

## What is hand-written and what is scaffold

- `src/`, `test/`, `docs/`, `scripts/` are hand-written. Do not regenerate, reformat or restructure them.
- Only the Site entry file and build configuration belong to the Sites scaffold. The entry must do one thing with this code: send `/mcp`, `/api/*`, `/`, `/healthz`, `/robots.txt` and `/files/*` to `createApp().fetch(request, env, ctx)` from `src/app.ts`.
- `.upstream/canvas-mcp` is a gitignored reference checkout of the Python source (run `scripts/fetch-upstream.sh` to recreate it). It is never bundled.

## Design documents

- `docs/DESIGN.md` is the approved design.
- `docs/design/architecture-detail.md` is the full module-level spec.
- `docs/design/review-findings.md` lists corrections to that spec. Where the two disagree, the review findings win.
- `src/types.ts` holds the shared interfaces. Change it only together with every module that uses the changed type.

## Rules the code must keep

- `src/` uses web-standard APIs and the D1/R2 binding objects only. No `node:*` or `cloudflare:*` imports, and nothing workerd-specific at module scope.
- No module-level mutable state that carries credentials, configuration or Canvas data between requests.
- Tool handlers receive a `ToolContext`. It has no `env` and no token, and that must stay true.
- Every Canvas path is built with `canvasPath` from `src/canvas/path.ts`. Never concatenate identifiers into a path.
- Anonymization is applied only inside the Canvas client. Tool modules must not import `src/core/anonymization.ts`.
- Canvas-authored text is fenced at the tool-output boundary with `src/core/untrusted-content.ts`, never inside the client.
- Secrets never appear in logs, errors, tool output or the status page. Real tokens never go in `.dev.vars` or `.env`.
- Tool names, descriptions and output wording follow upstream. Record every deliberate difference in `docs/PORTING.md`.

## Commands

- `npm run typecheck`
- `npm test` (vitest, Node environment)
- `npx vitest run test/unit/<file>.test.ts` for one file
