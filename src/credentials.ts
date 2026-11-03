/**
 * Credential resolution for the OpenCode Go usage panel.
 *
 * OpenCode 2 (v2.2+) keeps provider credentials in the local SQLite database
 * (`credential` table), not in `auth.json`. The `auth.json` file still exists
 * and is read as a legacy fallback, but on machines that have migrated its
 * entries are typically stale and return `api_key_expired`.
 *
 * Resolution order, first match wins:
 *
 *   1. environment  OPENCODE_GO_API_KEY | OPENCODE_API_KEY | OPENCODE_ZEN_API_KEY
 *   2. config-file  <config>/opencode-quota/opencode-go.json  -> `apiKey`
 *   3. OpenCode 2   <data>/opencode/opencode.db  `credential` row  (integration `opencode-go`)
 *   4. legacy       <data>/opencode/auth.json  -> `opencode-go`, then `opencode`
 *   5. console      workspace id + session cookie (env, then the shared config file)
 *
 * The API key path is preferred: it needs no browser session and the endpoint
 * reports percentages directly.
 *
 * NOTE: nothing here touches `process` at module top level. The OpenCode 2 TUI
 * does not expose `process` while the plugin module is evaluated, so a
 * top-level read aborts initialization silently.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type Credentials =
  | { kind: "api"; apiKey: string; source: string }
  | { kind: "console"; workspaceId: string; authCookie: string; source: string }
  | { kind: "none"; reason: string }

export interface CredentialInputs {
  env?: Record<string, string | undefined>
  /** OpenCode data dir; defaults to `$XDG_DATA_HOME` or `~/.local/share`. */
  dataHome?: string
  /** OpenCode config dir; defaults to `$XDG_CONFIG_HOME` or `~/.config`. */
  configHome?: string
}

const CREDENTIAL_SQL =
  "select value from credential where integration_id = ? and active = 1 order by time_updated desc limit 1"

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function resolveDataHome(env: Record<string, string | undefined>, override?: string): string {
  if (override) return override
  const xdg = optionalString(env.XDG_DATA_HOME)
  return xdg ? xdg : join(homedir(), ".local", "share")
}

function resolveConfigHome(env: Record<string, string | undefined>, override?: string): string {
  if (override) return override
  const xdg = optionalString(env.XDG_CONFIG_HOME)
  return xdg ? xdg : join(homedir(), ".config")
}

/** The shared config the console-cookie path (and the pi extension) reads. */
export function quotaConfigPath(env: Record<string, string | undefined>, override?: string): string {
  return join(resolveConfigHome(env, override), "opencode", "opencode-quota", "opencode-go.json")
}

function opencodeDbPath(env: Record<string, string | undefined>, override?: string): string {
  return join(resolveDataHome(env, override), "opencode", "opencode.db")
}

function opencodeAuthPath(env: Record<string, string | undefined>, override?: string): string {
  return join(resolveDataHome(env, override), "opencode", "auth.json")
}

/**
 * Run a single read-only query against a SQLite file.
 *
 * OpenCode ships as a Bun binary, so `bun:sqlite` is the primary driver. The
 * `node:sqlite` loader covers a Node-hosted TUI. Both are loaded lazily and any
 * failure falls through silently: a missing or locked database must never take
 * down the panel.
 */
async function queryCredentialRow(dbPath: string, integrationId: string): Promise<unknown> {
  if (!existsSync(dbPath)) return undefined

  const loaders: ReadonlyArray<() => Promise<unknown>> = [
    async () => {
      const sqlite: any = await import("bun:sqlite")
      const db = new sqlite.Database(dbPath, { readonly: true })
      try {
        return db.query(CREDENTIAL_SQL).get(integrationId)
      } finally {
        db.close()
      }
    },
    async () => {
      // Built from parts so the bundler cannot rewrite the specifier.
      const specifier = ["node", "sqlite"].join(":")
      const sqlite: any = await import(/* @vite-ignore */ specifier)
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
      try {
        return db.prepare(CREDENTIAL_SQL).get(integrationId)
      } finally {
        db.close()
      }
    },
  ]

  for (const load of loaders) {
    try {
      const row = await load()
      if (row) return row
    } catch {
      // Driver unavailable, database locked, schema changed — try the next one.
    }
  }
  return undefined
}

/** `credential.value` is JSON: `{"type":"key","key":"oc_sk_..."}`. */
function keyFromCredentialValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value)
    const body = record(parsed)
    return (
      optionalString(body?.key) ??
      optionalString(body?.apiKey) ??
      optionalString(body?.api_key) ??
      optionalString(body?.token)
    )
  } catch {
    // Some builds may store the bare key.
    return optionalString(value)
  }
}

async function readJson(path: string): Promise<{ data?: unknown; missing: boolean; error?: string }> {
  try {
    return { data: JSON.parse(await readFile(path, "utf-8")), missing: false }
  } catch (err: any) {
    if (err?.code === "ENOENT") return { missing: true }
    return { missing: false, error: err?.message ?? String(err) }
  }
}

async function apiKeyFromDatabase(dbPath: string): Promise<string | undefined> {
  const row = record(await queryCredentialRow(dbPath, "opencode-go"))
  if (!row) return undefined
  return keyFromCredentialValue(row.value)
}

function apiKeyFromAuthStore(store: unknown): { key: string; entry: string } | undefined {
  const root = record(store)
  for (const entry of ["opencode-go", "opencode"]) {
    const key = optionalString(record(root?.[entry])?.key)
    if (key) return { key, entry }
  }
  return undefined
}

export async function resolveCredentials(inputs: CredentialInputs = {}): Promise<Credentials> {
  const env = inputs.env ?? process.env

  // 1. Environment.
  const envKey =
    optionalString(env.OPENCODE_GO_API_KEY) ??
    optionalString(env.OPENCODE_API_KEY) ??
    optionalString(env.OPENCODE_ZEN_API_KEY)
  if (envKey) return { kind: "api", apiKey: envKey, source: "env" }

  const shared = await readJson(quotaConfigPath(env, inputs.configHome))
  const sharedConfig = record(shared.data)

  // 2. Explicit pin in the shared config file.
  const configKey = optionalString(sharedConfig?.apiKey)
  if (configKey) return { kind: "api", apiKey: configKey, source: "config file" }

  // 3. OpenCode 2's credential store — the same key the models use.
  const dbKey = await apiKeyFromDatabase(opencodeDbPath(env, inputs.dataHome))
  if (dbKey) return { kind: "api", apiKey: dbKey, source: "opencode auth" }

  // 4. Legacy `auth.json` store.
  const legacy = await readJson(opencodeAuthPath(env, inputs.dataHome))
  const legacyKey = apiKeyFromAuthStore(legacy.data)
  if (legacyKey) {
    return { kind: "api", apiKey: legacyKey.key, source: `auth.json (${legacyKey.entry})` }
  }

  // 5. Console session cookie — legacy transport, kept as a fallback.
  const envWorkspace = optionalString(env.OPENCODE_GO_WORKSPACE_ID)
  const envCookie = optionalString(env.OPENCODE_GO_AUTH_COOKIE)
  if (envWorkspace && envCookie) {
    return { kind: "console", workspaceId: envWorkspace, authCookie: envCookie, source: "env" }
  }

  const sharedWorkspace = optionalString(sharedConfig?.workspaceId)
  const sharedCookie = optionalString(sharedConfig?.authCookie)
  if (sharedWorkspace && sharedCookie) {
    return {
      kind: "console",
      workspaceId: sharedWorkspace,
      authCookie: sharedCookie,
      source: "config file",
    }
  }

  // 6. Nothing usable. Say why, distinguishing "no file" from "file is broken".
  if (shared.error) return { kind: "none", reason: `config file: ${shared.error}` }
  if (envWorkspace || envCookie) {
    return {
      kind: "none",
      reason: `missing ${envWorkspace ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID"}`,
    }
  }
  return { kind: "none", reason: "no OpenCode Go credential found" }
}
