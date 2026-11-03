# Install

OpenCode 2 sidebar plugin that shows OpenCode Go subscription usage (rolling,
weekly, monthly).

## Prerequisites

- **OpenCode 2** — the terminal CLI. Verify with:
  ```bash
  opencode2 --version   # prints 2.x
  ```
- Node.js or Bun (to build the plugin).
- An OpenCode Go subscription with a valid console session cookie + workspace id.

> This plugin targets **OpenCode 2** only. It uses the new V2 plugin API
> (`@opencode/plugin/tui`, `Plugin.define`, `context.ui.slot`). For OpenCode 1,
> use the separate `opencode-go-stats-plugin`.

## Quick install (from source)

```bash
git clone git@github.com:anibalardid/opencode-v2-go-usage-stats-plugin.git
cd opencode-v2-go-usage-stats-plugin
npm install
npm run build          # emits tui.js at the repo root
```

Then pick one registration mode:

**A. Register as a package path** in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-v2-go-usage-stats-plugin"]
}
```

**B. Symlink into the plugins directory** (auto-discovered, no config edit):

```bash
ln -s "$(pwd)" ~/.config/opencode/plugins/go-usage
```

Restart the OpenCode 2 TUI. You'll see an **OpenCode Go** section in the sidebar
of any session.

> If you isolate OpenCode 2 with a custom config dir, use that dir's `cli.json` /
> `plugins/` instead (e.g. `~/.config/opencode-v2/`).

The build emits **`tui.js` at the repository root** on purpose: OpenCode 2
discovers a local plugin *directory* by looking for `tui.ts` / `tui.js` at the
directory root, not via `package.json` `exports`.

## Credentials setup

The plugin reads usage from the OpenCode Console JSON API; it needs your console
session cookie and workspace id.

**Option A — env vars:**

```bash
export OPENCODE_GO_AUTH_COOKIE="your-session-cookie-value"
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
```

**Option B — config file:** create
`~/.config/opencode/opencode-quota/opencode-go.json`:

```json
{
  "authCookie": "st_xxxxxxxx-....",
  "workspaceId": "wrk_01ABC..."
}
```

### How to get the credentials

1. Open [opencode.ai](https://opencode.ai) and sign in.
2. Go to `https://opencode.ai/console/<your-workspace>/go`.
3. DevTools → **Application** (Chrome/Edge) or **Storage** (Firefox) →
   **Cookies** → `opencode.ai` → copy `__Host-console_session` (a `st_...` token).
4. Your **workspace id** is the `wrk_...` slug in the URL path.

The `__Host-console_session` cookie expires — when the panel shows `Auth 401/403`,
re-copy it from DevTools.

## How to update

```bash
cd opencode-v2-go-usage-stats-plugin
git pull
npm install
npm run build
# Restart the OpenCode 2 TUI
```

## Uninstall

Remove the entry from `~/.config/opencode/cli.json` (or delete the symlink under
`~/.config/opencode/plugins/`), then delete the folder:

```bash
rm -rf opencode-v2-go-usage-stats-plugin
```

## Requirements

- macOS / Linux
- OpenCode 2 (`opencode2`)
- An OpenCode Go subscription with a valid console session cookie
