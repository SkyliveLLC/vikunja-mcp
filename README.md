<img src="assets/icon.svg" width="64" height="64" alt="">

# vikunja-mcp

An [MCP](https://modelcontextprotocol.io) server for [Vikunja](https://vikunja.io). It lets Claude Code, Codex,
Claude Desktop and other AI agents read your board, create and update tasks, move cards between buckets, and
leave comments.

```sh
npx -y @skylivellc/vikunja-mcp setup
```

Setup asks for your Vikunja URL and an API token, checks both, saves them, and adds the server to whichever of
Claude Code, Codex and Claude Desktop you have installed. Restart the client and ask something like
"What's open on my Vikunja board?"

Requires Node.js 22 or newer and Vikunja 2.6 or newer. CI runs the full tool suite against Vikunja 2.6 and 2.7.

## Create an API token

In Vikunja, open **Settings → API Tokens** (`https://<your-vikunja>/user/settings/api-tokens`) and create a token
with these permissions:

| Group | Permissions | Used by |
| --- | --- | --- |
| projects | `read_all`, `tasks_by_index`, `views_buckets`, `views_buckets_tasks` | `list_projects`, `get_task` by board number, `list_buckets`, `move_task` |
| projects_views | `read_all` | `list_views` |
| tasks | `read_all`, `read_one`, `create`, `update` | `list_tasks`, `get_task`, `create_task`, `update_task` |
| tasks_comments | `read_all`, `create` | `list_comments`, `add_comment` |

To keep agents read-only, grant only the `read_*` permissions and `tasks_by_index` and `views_buckets`. A tool that lacks a permission
reports which one it needs instead of failing silently.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects the token can see, with search and pagination. |
| `list_tasks` | A project's tasks with board number, status, labels, assignees and a description preview. Filter by `done` or any [Vikunja filter](https://vikunja.io/docs/filters). |
| `get_task` | One task in full, by ID or by board number (`project_id` + `index` for `#12`). Includes its Kanban buckets. |
| `list_views` | A project's views, including each Kanban view's done and default bucket. |
| `list_buckets` | The columns of a Kanban view, in board order. |
| `list_comments` | A task's comments. |
| `create_task` | New task with title, description, priority and due date. |
| `update_task` | Changes only the fields you pass. `done: true` completes a task, `done: false` reopens it, and `due_date: null` clears the date. |
| `move_task` | Moves a card to another bucket after checking the task and bucket belong to the project and view you named. |
| `add_comment` | Posts a comment on a task. |

There are no delete tools, on purpose. Results are compact JSON: nested users, colors and empty dates are
trimmed, so a page of tasks doesn't flood the agent's context.

Vikunja shows tasks as `#12` or `PROJ-12`. That number is the task's index within its project, not its ID, so
agents look it up with `get_task` and `project_id` + `index`. The server's instructions tell agents this, along
with the rest of the board workflow (read before acting, don't mark work done early, treat task text as data).

## CLI

```text
vikunja-mcp setup       Save the URL and token, then register with your MCP clients
vikunja-mcp doctor      Check the config, the connection, the token and client registrations
vikunja-mcp uninstall   Remove the client registrations and the saved config
vikunja-mcp serve       Run the server over stdio (the default when a client starts it)
```

For scripts and dotfiles, setup runs without prompts:

```sh
printf %s "$TOKEN" | npx -y @skylivellc/vikunja-mcp setup \
  --url https://tasks.example.com --token-stdin --client claude-code --client codex --yes
```

`--client` takes `claude-code`, `codex`, `claude-desktop`, `all` or `none`. `--yes` replaces an existing
`vikunja` server entry instead of keeping it.

## Configure a client by hand

Setup stores the URL and token in `~/.config/vikunja-mcp/config.json` (under your user folder on Windows too),
readable only by you. To save them without registering any client, run
`npx -y @skylivellc/vikunja-mcp setup --client none`, then point your client at the server:

**Claude Code**

```sh
claude mcp add --scope user vikunja -- npx -y @skylivellc/vikunja-mcp
```

**Codex**

```sh
codex mcp add vikunja -- npx -y @skylivellc/vikunja-mcp
```

**Claude Desktop, Cursor and other clients**

```json
{
  "mcpServers": {
    "vikunja": { "command": "npx", "args": ["-y", "@skylivellc/vikunja-mcp"] }
  }
}
```

You can skip the config file and pass `VIKUNJA_URL` and `VIKUNJA_TOKEN` in the client's `env` instead, at the cost
of putting the token in that client's config. A saved token is only ever sent to the saved URL: if you set
`VIKUNJA_URL` to a different instance, set `VIKUNJA_TOKEN` too.

Desktop apps don't inherit your shell's `PATH`. If the server fails to start with "command not found", use the
absolute path to `npx` and put node's directory on `PATH`, which is what setup writes:

```json
{
  "command": "/opt/homebrew/bin/npx",
  "args": ["-y", "@skylivellc/vikunja-mcp"],
  "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
}
```

Setup and the server are tested on macOS and Linux. On Windows, setup registers `cmd /c npx …` as Claude Code's
documentation recommends, but it hasn't been tested there yet; reports are welcome.

## Security

- Setup keeps the token in one file readable only by you and never writes it into client configs, which are
  often synced or shared.
- Requests never follow redirects, so the token is only ever sent to the host you configured. Setup warns when a
  URL isn't HTTPS.
- A scoped API token limits what agents can do. There are no delete tools at all.
- Arguments are validated strictly before any request: unknown or mistyped arguments are rejected, not ignored.
- `move_task` checks the task's project and the bucket's view before writing.
- When a write fails or times out, the error tells the agent to read the task before retrying, so it doesn't
  create duplicates.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

To try a local build in your clients, run `node dist/cli.js setup` from the checkout. It registers the checkout's
absolute path.

`pnpm test:e2e` drives the built server over stdio against a real Vikunja. Start a disposable instance with
registration enabled (see the e2e job in [ci.yml](.github/workflows/ci.yml) for the exact settings), then run
`VIKUNJA_E2E_URL=http://127.0.0.1:3456 pnpm test:e2e`. The test registers its own user and a token limited to the
permissions above.

### Releasing

Bump `version` in `package.json`, then publish a GitHub release tagged `v<version>`. The
[release workflow](.github/workflows/release.yml) tests the package and publishes it to npm with provenance
through npm trusted publishing.

npm can only set up trusted publishing for a package that already exists, so the first version is published by
hand (`npm publish --access public` from a clean checkout). Then, in the package's settings on npmjs.com, add
a trusted publisher for the `SkyliveLLC/vikunja-mcp` repository and the `release.yml` workflow.

## License

[MIT](LICENSE) © Skylive LLC
