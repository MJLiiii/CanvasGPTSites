// The Worker entry. All behaviour lives in src/app.ts; a Sites scaffold's own entry forwards to the same call.
import { createApp } from '../src/app';
import type { AppExecutionContext } from '../src/app';
import type { Env } from '../src/types';

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx?: AppExecutionContext): Promise<Response> => app.fetch(request, env, ctx),
};
