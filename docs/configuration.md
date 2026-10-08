# Configuration

## Setup

```bash
npm ci
npm run setup        # same as: co-dev-review init
```

`setup` does five things, asking before each one:

1. **Credentials.** It asks for each setting and shows the saved value, with tokens masked to their last four characters. Press Enter to keep a value, or type `-` to clear it.
2. **Connections.** It runs `doctor`: read-only authentication checks for each configured integration.
3. **Assistants.** It registers the server in every assistant installed on the machine (see below).
4. **Skills.** It links the review skills into the skill folders of Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`) and Copilot (`~/.copilot/skills`). These are junctions on Windows, so editing a rubric updates every assistant. A folder it didn't create is never replaced unless you pass `--force`.
5. **Global command.** If `co-dev-review` isn't on `PATH`, it offers `npm install -g` on this folder, so `co-dev-review approve` works from any terminal.

Restart or reload each assistant afterwards.

| Option | Effect |
| --- | --- |
| `--clients claude-code,codex` | Only these assistants (registered even if not detected) |
| `--yes` | No questions: register every detected assistant and link the skills |
| `--no-config` | Skip the credential questions |
| `--no-skills` | Don't link skills |
| `--import <mcp.json>` | First import allowlisted settings from another MCP configuration's `env` blocks |
| `--force` | Replace skill folders that aren't this package's links |

`co-dev-review uninstall [--clients …]` removes the registrations and skill links. Your configuration and drafts are kept.

## Settings

| Setting | Required for | Notes |
| --- | --- | --- |
| `GITLAB_URL` | GitLab | Default `https://gitlab.com` |
| `GITLAB_TOKEN` | GitLab | Personal access token with `api` scope |
| `GITLAB_PROJECT_ID` | GitLab | Default project (id or `group/repo`); a target can name another one |
| `GITHUB_API_URL` | GitHub | Default `https://api.github.com` |
| `GITHUB_TOKEN` | GitHub | Pull request read and comment |
| `AZURE_DEVOPS_ORG_URL` | Azure DevOps | `https://dev.azure.com/<organization>` |
| `AZURE_DEVOPS_PROJECT` | Azure DevOps | One project per installation |
| `AZURE_DEVOPS_TOKEN` | Azure DevOps | PAT with Work Items read & write |
| `JIRA_URL` | Jira | `https://<site>.atlassian.net` or your server |
| `JIRA_EMAIL` | Jira Cloud | With an API token (Basic auth); leave empty on Server/Data Center (PAT, Bearer) |
| `JIRA_TOKEN` | Jira | API token or personal access token |
| `JIRA_ASSIGNEE` / `JIRA_SUBTASK_TYPE` / `JIRA_ACCEPTANCE_FIELD` | optional | Default assignee (Cloud accountId), sub-task type name (default `Sub-task`), custom field holding acceptance criteria |
| `GITHUB_REPO` / `GITHUB_ASSIGNEE` | GitHub Issues | Default `owner/repo` for issue ids and searches; default assignee login |
| `TICKET_TRACKER` | optional | Tracker for bare numeric ids: `azure`, `jira` or `github` |
| `AZURE_DEVOPS_ASSIGNEE` | optional | Email or unique name that created tasks are assigned to; a task can name its own |
| `SONAR_URL` | Sonar | Default `https://sonarcloud.io` |
| `SONAR_TOKEN` | Sonar | |
| `SONAR_PROJECT_KEY` | Sonar | |
| `REVIEW_REPO_ROOT` | checkout, checks, blast radius, local reviews | Absolute path of a clone of the reviewed repository |
| `REVIEW_REMOTE` | optional | Remote MR/PR heads are fetched from; default `origin` |
| `REVIEW_WORKTREE_DIR` | optional | Where review worktrees go; default beside `REVIEW_REPO_ROOT` |
| `REVIEW_DOTNET_PROJECT` | optional | `.sln`/`.csproj` for `checks` when auto-detection picks the wrong one |
| `REVIEW_APPROVAL` | optional | `conversation` (default: approve by replying in the chat), `in-chat` (MCP form), `browser`, `terminal` or `auto` (form, then browser, then terminal). Anything but `conversation` disables approval by chat reply |
| `REVIEW_CHECKOUT` | optional | `ask` (default: ask diff-only or worktree, and which package manager), `always` or `never` |
| `EXTRA_CA_CERTS` | optional | `.pem` of a corporate proxy's CA; see below |

In JSON, write Windows paths with forward slashes, or escape the backslashes.

## Where configuration and state live

The configuration, drafts, approvals, deterministic runs, worktree registry and trace all live in one folder per user:

1. `CO_DEV_HOME`, when set;
2. otherwise `.local/` in the installation folder, if it already exists (older installs);
3. otherwise `~/.co-dev-review/`.

`config.json` in that folder holds the settings. Environment variables with the same names override it. `.env` files are not loaded.

The folder holds your tokens: keep it private. `.local/` is git-ignored.

## How assistants are registered

| Assistant | Where | Notes |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user` | Needs the `claude` command on `PATH` |
| Claude Desktop | `claude_desktop_config.json` in the app's config folder | |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | Sets `tool_timeout_sec = 900`; the 60 s default is shorter than a dependency install |
| VS Code + Copilot | user `mcp.json` (`servers` key) | |
| Copilot CLI | `~/.copilot/mcp-config.json` | |
| Cursor | `~/.cursor/mcp.json` | |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | Some versions read `~/.gemini/config/mcp_config.json`; copy the entry there if the server doesn't appear |
| Gemini CLI | `~/.gemini/settings.json` | Sets a 900 s timeout |

Each entry starts the server with the absolute path of the current Node and of `src/server.js`. Nothing depends on `PATH` or on `.cmd` shims, which some clients cannot launch on Windows.

Other servers and settings in those files are preserved, comments included, and each file is backed up as `<file>.co-dev-review.bak` before its first edit. Run `setup` again after moving the folder or upgrading Node.

### Any other client, by hand

Copy the matching entry from [`examples/`](../examples/) and replace `/absolute/path/to/co-dev-review` with this folder's path. The server speaks MCP over stdio, so any client that supports stdio servers works. Clients without a skill system get the rubrics over MCP through `step=rubric`.

### Claude Code as a plugin

For Claude Code, you can load the folder as a plugin instead of registering it with `setup`; the server and skills then load together:

```bash
claude --plugin-dir /absolute/path/to/co-dev-review
```

Use either the plugin or the `setup` registration, not both, or the server is registered twice. `co-dev-review uninstall --clients claude-code` removes the `setup` registration.

### Checking what a client sees

```bash
npm run tools     # starts a temporary server and prints the tools and their steps
npm run schema    # also lists the JSON Schema constructs each tool uses
```

If an assistant shows fewer steps than `npm run tools`, it is holding an older schema; reconnect the server. If a client rejects a tool outright, `npm run schema` shows which constructs (`anyOf`, `const`, `additionalProperties`…) it might not support.

## Behind a corporate proxy

If `co-dev-review doctor` reports `SELF_SIGNED_CERT_IN_CHAIN` (or another certificate error) for every provider at once, your tokens are fine. A proxy or endpoint-security product (Zscaler, Kaspersky, Netskope…) is re-signing HTTPS with its own certificate authority. Your OS and browser trust that authority; Node 20 doesn't, because it ships its own CA bundle. Node 22.15+ and 24 read the Windows store natively, so upgrading Node also fixes it.

1. Export the proxy's CA to a `.pem` file. On Windows, replace `Kaspersky` with the issuer your browser shows in the padlock:

   ```powershell
   $certs = Get-ChildItem Cert:CurrentUserRoot, Cert:LocalMachineRoot, Cert:CurrentUserCA, Cert:LocalMachineCA -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*Kaspersky*' } | Sort-Object Thumbprint -Unique
   $pem = ($certs | ForEach-Object { "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----" }) -join "`n"
   [IO.File]::WriteAllText("$env:USERPROFILE\.node-extra-ca.pem", $pem + "`n")
   ```

   On macOS or Linux, export it from Keychain Access or `/etc/ssl/certs`.

2. Set `EXTRA_CA_CERTS` to that file, in `setup` or in `config.json`.

3. Restart the assistant.

Node reads certificates only at startup, and assistants launch the server with whatever environment they started with. So when `EXTRA_CA_CERTS` is set and `NODE_EXTRA_CA_CERTS` isn't, the server relaunches itself once with the variable set. Afterwards, `co-dev-review doctor` shows `connected` for each provider and the CA file on its first line.

This adds a CA to Node's bundle rather than replacing it, so verification is not weakened. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`: it disables verification for every host, and would let the server publish comments to an impostor.
