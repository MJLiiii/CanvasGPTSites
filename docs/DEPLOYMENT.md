# Deploy your own Canvas Site

This guide deploys one private Site for one owner. Every person following it creates their own Site and plugin and configures their own Canvas credentials. Sites authenticates the plugin connection; this application separately checks the configured owner before using the Canvas token.

## 1. Check the cloned repository

Use Node.js 22.13.0 or later. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The root build is a test harness, not the production publishing artifact. Do not upload its output as a replacement for the official Sites build.

## 2. Generate and prepare the official scaffold

In Codex, enable Sites and ask it to generate its current official Vinext starter in an empty `site/` directory. Codex must follow the installed Sites building and hosting skills; their location depends on the installation, so this repository does not hard-code a local plugin path.

Do not copy the author's `site/`, `.git`, `.openai/hosting.json`, project ID, or deployment records. A fresh clone intentionally excludes `site/`. Existing deployments must be opened through the Sites hosting workflow before edits.

Once the official starter exists, run from the repository root:

```sh
node scripts/prepare-site.mjs
```

The script adds the MCP capability and D1 `DB` binding, then forwards `/mcp`, `/api/*`, `/`, `/healthz`, `/robots.txt`, and `/files/*` to `createApp().fetch(request, env, ctx)`. It preserves the official fallback routes, connector wrapper, build configuration and any existing Site identity. R2 is not needed for the current tools; an existing `FILES` binding is preserved.

If the helper reports an unfamiliar scaffold or conflicting binding, stop and have Codex inspect the actual official entry. Do not bypass the checks or replace the starter with a generic Worker. Validate the adapter against that starter before continuing.

For a custom scaffold directory, both helpers accept the same argument:

```sh
node scripts/prepare-site.mjs --site-dir ./my-site
```

Keep custom scaffold directories outside handwritten source folders and exclude them from the public repository. The default `site/` is already ignored.

## 3. Register your Site and synchronize source

Ask Codex to register a new private Site through the native Sites tools, retaining the project ID returned by registration in **this scaffold's** `.openai/hosting.json`. Registration leaves the Site unpublished. If this scaffold is already registered to your deployment, reuse that identity; do not create another Site on updates or retry an uncertain registration blindly.

The hosting manifest uses `d1: "DB"`, `r2: null` unless `FILES` is already configured, and includes `"mcp"` in capabilities. Secrets do not belong in the manifest.

Then synchronize:

```sh
node scripts/sync-site-source.mjs
```

Or pass `--site-dir ./my-site` for the same custom directory. Synchronization requires a registered, prepared Site. It replaces destination `src/` with the authoritative root source and merges runtime dependencies, preserving the Site ID and official package scripts. Do not edit destination `src/` independently.

After the first synchronization, or whenever runtime dependencies change, refresh the scaffold lockfile before using the official installer (which runs `npm ci`):

```sh
cd site
npm install --package-lock-only --ignore-scripts
cd ..
```

Use your custom directory if applicable. Then have Codex install the scaffold's dependencies using the current Sites installation helper before building. Keep the refreshed lockfile with the Site's source; unchanged dependencies need no lockfile refresh.

## 4. Configure your deployment

Open **your new Site's settings**. Enter these values directly, marked as secrets:

| Secret | Meaning |
| --- | --- |
| `CANVAS_API_URL` | Your institution's Canvas homepage, such as `https://canvas.example.edu`; the app normalizes it to `/api/v1` |
| `CANVAS_API_TOKEN` | Your own personal Canvas token, created in your Canvas account if permitted by your institution |
| `OWNER_EMAIL` | The email used to sign in to ChatGPT and connect this Site's plugin |

Do not send the token in Codex chat or put it in a tracked file, `.env`, `.dev.vars`, parity file, screenshot, or command argument.

Normal settings:

| Setting | Recommended value |
| --- | --- |
| `AUTH_MODE` | Unset, or `owner` for compatibility; other modes are rejected |
| `MCP_BACKEND` | `sdk` (default) |
| `MCP_PATH` | `/mcp` (default; the adapter forwards this endpoint) |
| `CANVAS_ROLE` | `student` (default) |
| `TIMEZONE` | Your IANA time zone; the default is `UTC` |
| `ALLOWED_HOSTS` | Optionally your actual Site hostname, without scheme or path |
| `DIAGNOSTICS_ENABLED` | Unset or `false` |
| `ALLOWED_WRITE_TOOLS` | Unset or `none` |

Keep the Site audience restricted to yourself. Changing the audience does not create per-user Canvas accounts; other people should deploy their own instance.

`OWNER_USER_ID_SHA256` is optional: leave it unset unless you have separately verified the gateway ID for this Site and its stability. Do not copy another Site's ID hash. Optional `PSEUDONYM_SALT` can strengthen pseudonym privacy; optional `CONFIRMATION_SECRET` belongs to the planned confirmation mechanism and is not needed by the current read tools. If set, save them as independent Site secrets, never copy the fake example values. Keep anonymization and log redaction enabled.

Diagnostics cannot run while a Canvas token or confirmation secret is configured. Do not enable diagnostics as a workaround for a production connection failure. Saved environment changes must be included in a new deployment before validating their runtime effect.

## 5. Build and publish privately

Ask Codex to use the official Sites hosting workflow for this registered checkout. It must preserve the generated build process, push source to the Site's source repository, package the official build, and save and deploy the resulting version privately. A push to GitHub does not perform any of these steps.

Before packaging, run the root checks and the official scaffold build. Run the repository's additional artifact scan against the scaffold:

```sh
node build/validate-artifact.mjs ./site --scan-only
```

Use your custom directory instead of `./site` if applicable. This scan supplements the official packaging validation. Wait for the native deployment status to report success and use its returned URL. Source repository credentials stay in the Sites workflow's session memory and hidden stdin, not in files or shell arguments.

## 6. Connect and verify

Install and connect the **plugin automatically provisioned for your Site**. Codex can obtain its plugin ID through Sites and show the installation UI. Otherwise open Plugins → Personal → Created by you and locate your Site's plugin. Do not create a separate app or local MCP registration.

Sign into your Site using the account configured in `OWNER_EMAIL`. The owner status page should show the token as configured, diagnostics off and 11 registered read tools. Use **Check the Canvas token** to make a read-only `/users/self` request. The page reports the result without exposing the token.

In a chat with your plugin connected, ask it to list your courses or check upcoming assignments. If an installed plugin still lists diagnostic tools, open its management page and choose **Refresh tools**, then open or refresh the chat. Verify that `list_courses` and `get_my_upcoming_assignments` are available.

## Updates and troubleshooting

For updates, open the same Site through the official hosting workflow, update the root source, rerun preparation and synchronization, refresh the scaffold lockfile and install dependencies if they changed, run checks, and publish to the same project. Keep the existing secrets and plugin connection.

| Symptom | Check |
| --- | --- |
| No `site/` after cloning | Generate the official starter in step 2; it is intentionally ignored |
| Synchronization requires registration | Complete step 3 in that exact scaffold directory |
| Official installer reports a lockfile mismatch | Refresh the scaffold lockfile after merging application dependencies in step 3 |
| `Server misconfigured` | Status/configuration errors, unsupported `AUTH_MODE`, bindings, and diagnostics accidentally enabled with credentials |
| Owner access denied | ChatGPT login email, Site audience, and any configured owner ID hash |
| Canvas check returns 401/403 | Your Canvas URL, token validity, token scope, and institution permissions |
| Only old diagnostic tools appear | Deploy the business version, refresh plugin tools, and refresh the chat |
| Deadlines appear on a different day | `TIMEZONE` and the date range supplied to the tool |
| Browser shows an error after token check | Inspect sanitized server request status; preserve owner and origin checks |

A successful build or deployment is not proof that every platform identity security test passed. Historical incomplete tests remain recorded in `SPIKE.md`; this guide does not label them as passed.
