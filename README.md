# Canvas GPT Sites

A TypeScript port of [canvas-mcp](https://github.com/vishalsachdev/canvas-mcp), hosted as a Cloudflare Worker on ChatGPT Sites and used through the plugin provisioned by Sites.

Each person deploys **their own private Site**, saves **their own Canvas token** in that Site's secret settings, and installs **their own plugin**. A Site serves one configured owner. Sharing this repository does not share a Canvas account or a deployed Site.

## Current capabilities

The application implements 11 read-only Canvas tools:

| Area | Tools |
| --- | --- |
| Courses | `list_courses`, `get_course_details`, `get_syllabus` |
| Your account | `get_my_profile`, `get_my_enrollments`, `get_my_course_grades` |
| Your work | `get_my_todo_items`, `get_my_upcoming_assignments`, `get_my_submission` |
| Assignments | `list_assignments`, `get_assignment_details` |

The full upstream tool set has not been ported. No Canvas write tools are currently registered. Per-user credential storage and Canvas OAuth are not implemented. The two platform diagnostic tools are disabled in a normal deployment.

## Requirements

- Node.js 22.13.0 or later and npm.
- Codex with the Sites plugin enabled, and an account with permission to create and deploy Sites. Repository scripts do not replace that platform access.
- A Canvas account whose institution permits personal API tokens.

## Start here

Clone this repository or your fork, then check the source:

```sh
git clone <repository-url> CanvasGPTSites
cd CanvasGPTSites
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` validates a local Worker bundle. **It does not publish a Site.** The official Sites scaffold is generated separately in ignored `site/`; it is deliberately absent from a fresh clone.

Follow [First deployment and updates](docs/DEPLOYMENT.md). You can start in Codex with:

> Follow docs/DEPLOYMENT.md to deploy this checkout as my own private Canvas Site. Generate the official Sites scaffold in site/, use the repository preparation and synchronization scripts, and create my own Site unless this checkout is already registered to my deployment. Reuse my registered Site for updates. Ask me to enter my Canvas URL, token and ChatGPT login email directly in the Site settings as secrets; never ask for the token in chat. Use the plugin automatically provisioned by Sites.

## Configuration

| Setting | Value |
| --- | --- |
| `CANVAS_API_URL` | Your school's HTTPS Canvas address; saved as a Site secret |
| `CANVAS_API_TOKEN` | Your own Canvas API token; saved as a Site secret |
| `OWNER_EMAIL` | The email of your **ChatGPT login**, not necessarily your Canvas login; saved as a Site secret |
| `AUTH_MODE` | Omit, or use `owner`; other values are rejected |
| `TIMEZONE` | Your IANA time zone, such as `Europe/Amsterdam`; defaults to `UTC` |
| `ALLOWED_HOSTS` | Optional restriction to your Site hostname; never copy another deployment's hostname |

The default role is `student`, diagnostics are off, anonymization and log redaction are on, and write tools are disabled. Optional identity hashing and privacy settings are described in the deployment guide. `.dev.vars.example` contains fake values only; never replace them with real secrets in repository files.

## Development

`src/` is the authoritative application source. `scripts/sync-site-source.mjs` copies it unchanged into the registered Site checkout. Do not maintain a second implementation in `site/src/`.

Run `npm run typecheck`, `npm test`, and `npm run build` before publishing. Upstream reference source is optional: `bash scripts/fetch-upstream.sh` creates an ignored, pinned checkout under `.upstream/`; it is never bundled. Tests use fake credentials and recorded offline fixtures.

The design documents describe both implemented behavior and historical migration plans. Use this README and the deployment guide for installation; see [porting differences](docs/PORTING.md) and [implementation history](docs/STATUS.md) for details.

## License

MIT. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) with redistributed copies, including the upstream canvas-mcp attribution. This project is not affiliated with Instructure or the upstream authors.
