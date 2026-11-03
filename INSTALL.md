# Install

OpenCode 2 sidebar plugin that shows OpenCode Go subscription usage (rolling,
weekly, monthly).

## Prerequisites

- **OpenCode 2** — the terminal CLI. Verify with:
  ```bash
  opencode2 --version   # prints 2.x
  ```
- Node.js or Bun (to build the plugin).
- An OpenCode Go subscription, signed in inside OpenCode 2.

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

## Credentials

Sign in to OpenCode Go inside OpenCode 2 once. The plugin reuses that credential
(same key the models use), so there is nothing else to configure.

Resolution order, first match wins:

1. `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`
2. `apiKey` in `~/.config/opencode/opencode-quota/opencode-go.json`
3. The `credential` table in `~/.local/share/opencode/opencode.db`
   (integration `opencode-go`, active row)
4. `~/.local/share/opencode/auth.json` — legacy store
5. Console cookie: `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`,
   then `workspaceId` + `authCookie` in the shared config file

Verify what the plugin sees without opening the TUI:

```bash
bun scripts/check.ts
```

It prints the resolved source and the live percentages, never the key.

### Console cookie fallback

Only needed on pre-V2 installs. Grab `__Host-console_session` (`st_...`) from
DevTools → Application → Cookies → `opencode.ai`, and the `wrk_...` id from
`https://opencode.ai/console/<workspace>/go`.

```json
{
  "authCookie": "st_xxxxxxxx-....",
  "workspaceId": "wrk_01ABC..."
}
```

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
- An OpenCode Go subscription, signed in inside OpenCode 2
