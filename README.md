# CanvasGPTSites

Copy this prompt into a Sites-enabled chat:

```text
Deploy https://github.com/MJLiiii/CanvasGPTSites to ChatGPT Sites
with its private Canvas Plugin.
Follow README.md and AGENTS.md; keep it single-owner and read-only.
Complete the setup, tests, build, and deployment. Guide me to enter my owner
email and Canvas secrets in Site Settings, then install and connect the
Plugin. Verify a read-only Canvas call after connection.
```

If the agent cannot access GitHub, attach the source or open it in Codex. You enter credentials and connect the Plugin yourself; technical steps are documented under [Development](#development).

A private Canvas integration for ChatGPT and Codex, hosted on ChatGPT Sites. This TypeScript port of [canvas-mcp](https://github.com/vishalsachdev/canvas-mcp) runs as a Cloudflare Worker and exposes Canvas tools through the Site's private Plugin.

The current release is **read-only and single-owner**. One owner can connect multiple Canvas instances, with a custom name, URL, and token for each institution.

## What you can do

The default student configuration provides these 12 tools:

| Tool | Function |
| --- | --- |
| `list_canvas_instances` | Discover configured connection IDs, names, and configuration availability. |
| `list_courses` | List your courses, optionally including past or concluded enrollments. |
| `get_course_details` | Read a course's dates, settings, and your enrollment role. |
| `get_syllabus` | Read the syllabus as plain text, HTML, or both. |
| `get_my_profile` | Read your own Canvas user ID, name, and login ID. |
| `get_my_enrollments` | List your enrollments and roles, optionally including concluded courses. |
| `get_my_course_grades` | Check your current grades across active courses. |
| `get_my_todo_items` | Read your Canvas TODO list. |
| `get_my_upcoming_assignments` | Find upcoming assignment, quiz, and discussion deadlines; the default window is seven days. |
| `get_my_submission` | Check submission status, attempts used, grade, and feedback comments. |
| `list_assignments` | List a course's assignments, with an option to include exact Canvas dates and checkpoints. |
| `get_assignment_details` | Read assignment instructions, dates, points, submission types, and lock status. |

Course lists and personal overview tools can query all configured instances and group results by connection. Course-specific and assignment-specific tools require a `canvas_instance` when multiple instances are configured. With one instance, it is selected automatically.

The Site also includes an owner-only status page showing configuration, available tools, and connection checks without displaying tokens. `list_canvas_instances` checks configuration only; a successful Canvas request is needed to verify a token.

This release does not submit assignments, post comments, change grades, or edit course content. Multi-user accounts and per-visitor Canvas credentials are not supported.

## Deploy with GPT Sites

You need access to Sites and its deployment tools in ChatGPT Work or Codex, the repository source, and a Canvas access token for each instance you want to connect. Available Sites and Plugin features depend on your account and workspace settings; see the [Sites documentation](https://learn.chatgpt.com/docs/sites).

Open this repository in Codex, or provide the complete source repository to a ChatGPT Work chat with Sites available. You can [download or clone the repository](https://github.com/MJLiiii/CanvasGPTSites). Include the source and build scripts, rather than only this README.

### Who does what

| Step | You | GPT Sites / Codex |
| --- | --- | --- |
| Provide source | Paste the prompt at the top of this README, or open or attach the repository. | Inspect the current source and repository instructions. |
| Prepare deployment | You can run the developer commands yourself if preferred. | Validate the source, create the official Site scaffold, and synchronize the application. |
| Register and publish | Choose the intended account or workspace. | Use Sites tools to register the project, build, save a version, and deploy privately. |
| Configure Canvas | Enter your owner email, Canvas URLs, and tokens in Site Settings. | Provide the settings location and required key names. |
| Connect the Plugin | Install it, sign in, and approve the connection. | Provide the Site's private Plugin and verify a read-only call after connection. |

### Enter your configuration

After the agent creates the Site, open **Sites → your Site → More actions → Settings**. Add runtime values there, using secret storage for tokens and the complete `CANVAS_CONNECTIONS` value. Keep real credentials out of prompts and repository files. Changes to hosted environment values require redeploying the saved version. See the [Sites configuration guide](https://learn.chatgpt.com/docs/sites#configure-runtime-environment-values).

Set `OWNER_EMAIL` to the email of the ChatGPT account that will use the Plugin. It must match the signed-in account; it may differ from your Canvas email.

**One Canvas instance**

| Key | Value |
| --- | --- |
| `OWNER_EMAIL` | Your ChatGPT account email. |
| `CANVAS_API_URL` | Your Canvas HTTPS URL, such as `https://canvas.example.edu`; a URL ending in `/api/v1` is also accepted. |
| `CANVAS_API_TOKEN` | Your Canvas access token, entered as a secret. |
| `INSTITUTION_NAME` | Optional display name for this connection. |

Leave `CANVAS_CONNECTIONS` unset for this configuration. Its connection ID will be `default`.

**Multiple Canvas instances**

Set `OWNER_EMAIL` and add a secret named `CANVAS_CONNECTIONS` containing a JSON array in this format. Replace the example values directly in Site Settings:

```json
[
  {
    "id": "university-a",
    "name": "University A",
    "url": "https://canvas-a.example.edu",
    "token": "REPLACE_WITH_CANVAS_TOKEN_A"
  },
  {
    "id": "university-b",
    "name": "University B",
    "url": "https://canvas-b.example.edu",
    "token": "REPLACE_WITH_CANVAS_TOKEN_B"
  }
]
```

Add or remove entries to match your institutions. IDs must be unique, start with a lowercase letter, and contain only lowercase letters, digits, underscores, or hyphens, with a maximum of 64 characters. Each connection needs a nonempty name, a valid HTTPS Canvas URL, and its own token.

When `CANVAS_CONNECTIONS` is set, it replaces `CANVAS_API_URL` and `CANVAS_API_TOKEN`. Invalid or empty JSON does not fall back to those settings. All connections belong to the same owner.

**Optional settings**

| Key | Default | Purpose |
| --- | --- | --- |
| `TIMEZONE` | `UTC` | Time zone for formatted dates, for example `Europe/Amsterdam`. |
| `CANVAS_ROLE` | `student` | Tool visibility: `student`, `educator`, or `all`. Educator mode hides student-only tools; it does not grant additional Canvas permissions. |
| `AUTH_MODE` | `owner` | The supported authentication mode. |
| `ALLOWED_WRITE_TOOLS` | No writes | Leave unset or use `none`. Changing this does not implement missing write tools. |
| `DIAGNOSTICS_ENABLED` | `false` | Keep disabled on a deployment holding Canvas credentials. |

### Install and verify the Plugin

Open **Plugins → Personal → Created by me**, find the Plugin provided for your Site, and install it. Complete the connection and sign-in prompts, then start a new chat. See the [Plugin installation guide](https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin).

Ask the Plugin to list your configured Canvas instances, then list your courses. The first request checks configuration; the second verifies access to Canvas. Use the owner account configured in `OWNER_EMAIL`.

The Site hosts the MCP server, and Sites provides the private Plugin that connects to it. There is no separate application-code conversion step.

## Example requests

Once the Plugin is connected, you can ask:

- "List my Canvas connections and courses."
- "What is due in the next 14 days across all my universities?"
- "Show my current grades, grouped by university."
- "Show the syllabus and grading policy for course BIO101 at University A."
- "List the assignments for BIO101 at University A, including their exact Canvas dates."
- "Check my submission status, remaining attempts, and feedback for assignment 123 in BIO101 at University A."

Use your own connection names, course codes or course IDs, and assignment IDs. With multiple instances, identify the institution for course-specific requests so the assistant can supply the correct `canvas_instance`.

## Access and limits

Only the configured owner can use the Canvas credentials. Data access also depends on the permissions of each Canvas token. Default privacy settings anonymize supported student identifiers and redact personal information in logs; results can still contain private academic information.

Calls have pagination, request, time, and output limits. Queries across several instances share a request budget and deadline. Results disclose partial failures or truncation, so large requests may need to be narrowed to one instance or course.

## Development

Use **Node.js 22.13.0 or later**. Run these commands in the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The root build uses esbuild to validate and bundle the Worker locally. Publishing requires the official Sites scaffold and its build/version/deployment workflow.

### Sites deployment workflow

After the root checks pass:

1. Create a fresh, ignored checkout with the official Sites starter. For updates, reuse only a verified active Site belonging to the owner; never reuse a deleted Site's identity.
2. From the repository root, run `node scripts/prepare-site.mjs --site-dir <directory>` to adapt routing, add the D1 binding `DB`, and enable the `mcp` capability.
3. Register the Site through Sites tools and save the returned project ID in the checkout's `.openai/hosting.json`.
4. From the repository root, run `node scripts/sync-site-source.mjs --site-dir <directory>`. In the Site checkout, refresh the lockfile with `npm install --package-lock-only --ignore-scripts`, then use the official Site dependency installer.
5. Let the owner enter runtime values directly in Site Settings. Keep `AUTH_MODE=owner`, `CANVAS_ROLE=student`, `ALLOWED_WRITE_TOOLS=none`, and `DIAGNOSTICS_ENABLED=false`, with default anonymization and log redaction enabled.
6. Build with the official Site workflow and scan the artifact from the repository root using `node build/validate-artifact.mjs <directory> --scan-only`. Use Sites tools to save and deploy that exact source privately.
7. Retrieve the Sites-provisioned private Plugin. After the owner installs and connects it, verify tool discovery and a read-only Canvas call. Report the Site URL and verification result without reproducing personal data; report any incomplete steps explicitly.

### Source layout

| Location | Purpose |
| --- | --- |
| `src/` | Authoritative application source; make application changes here. |
| `test/` | Unit and integration tests. |
| `scripts/prepare-site.mjs` | Adapt an official Sites starter with Canvas routes, the `DB` binding, and MCP capability. |
| `scripts/sync-site-source.mjs` | Copy root `src/` into a prepared, registered Site checkout and merge runtime dependencies. |
| `build/` and `entry/` | Local build and artifact-validation support. |
| `site/` | Default ignored deployment checkout; its `src/` is generated from root `src/`. |
| `.upstream/canvas-mcp` | Optional ignored Python reference checkout; never bundled. |

The preparation scripts accept `--site-dir <directory>`. They operate on an existing official Site starter; synchronization additionally requires a registered project ID. If synchronization changes dependencies, refresh that checkout's lockfile before installing them. For the final artifact scan, run `node build/validate-artifact.mjs <directory> --scan-only` from the repository root.

Follow [AGENTS.md](AGENTS.md) when changing the code. Edit root `src/`; synchronization overwrites the generated deployment copy. Updates can reuse a verified active Site and its Plugin. A deleted Site needs a new registration.

## License

MIT. See [LICENSE](LICENSE), including attribution to the original canvas-mcp project.
