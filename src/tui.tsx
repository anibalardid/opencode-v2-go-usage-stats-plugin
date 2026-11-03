/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

// ── Config ───────────────────────────────────────────────────────────────────
// OpenCode rediseñó el sitio (Sep 2026): la página /workspace/<id>/go pasó a
// /console/<id>/go y es una SPA. El uso real ahora se lee del API JSON:
//   GET https://opencode.ai/console/api/go/status
//   headers: Cookie: __Host-console_session=<token>   +   x-org-id: <workspaceId>
// El token es la cookie de sesión del nuevo console (ej: st_xxxxxxxx-...).
//
// NOTE: nothing here touches `process` at module top level on purpose. The
// OpenCode 2 TUI sandbox does not expose `process` while the module is
// evaluated, so a top-level `process.env` access aborts plugin initialization
// silently (the plugin is discovered but never renders). Env is read lazily
// inside resolveConfig().
const GO_STATUS_URL = "https://opencode.ai/console/api/go/status"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0"
const SCRAPE_TIMEOUT_MS = 10_000
const REFRESH_INTERVAL_MS = 180_000

const RETRY_DELAYS = [60_000, 60_000, 60_000] as const

// ── Config resolution ────────────────────────────────────────────────────────
interface GoConfig {
  authCookie: string
  workspaceId: string
  source: string
}

async function resolveConfig(): Promise<{ result?: GoConfig; error?: string }> {
  // 1. Env vars
  const envAuth = process.env.OPENCODE_GO_AUTH_COOKIE?.trim()
  const envWs = process.env.OPENCODE_GO_WORKSPACE_ID?.trim()
  if (envAuth && envWs) {
    return { result: { authCookie: envAuth, workspaceId: envWs, source: "env" } }
  }
  if (envAuth || envWs) {
    return {
      error: `Missing ${envAuth ? "OPENCODE_GO_WORKSPACE_ID" : "OPENCODE_GO_AUTH_COOKIE"}`,
    }
  }

  // 2. Config file
  const configPath =
    (process.env.HOME ?? "") + "/.config/opencode/opencode-quota/opencode-go.json"
  try {
    const fs = await import("fs/promises")
    const content = await fs.readFile(configPath, "utf-8")
    const parsed = JSON.parse(content)
    const authCookie =
      typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : ""
    const workspaceId =
      typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : ""
    if (authCookie && workspaceId) {
      return { result: { authCookie, workspaceId, source: configPath } }
    }
    return {
      error: `Incomplete config: missing ${authCookie ? "workspaceId" : "authCookie"}`,
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { error: "no config found" }
    }
    return { error: `Error reading config: ${err.message}` }
  }
}

// ── API types ────────────────────────────────────────────────────────────────
interface Meter {
  startsAt?: string
  resetsAt?: string
  limitMicroCents: string
  usedMicroCents: string
}

interface GoStatusResponse {
  access?: {
    startsAt?: string
    endsAt?: string
    meters?: {
      fiveHour?: Meter
      week?: Meter
      month?: Meter
    }
  }
}

interface WindowUsage {
  key: "fiveHour" | "week" | "month"
  label: string
  usagePercent: number
  resetText: string
}

interface GoUsageData {
  windows: WindowUsage[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// microcents: 100,000,000 == 1 USD
function pctOf(m?: Meter): number {
  if (!m) return 0
  const used = Number(m.usedMicroCents)
  const limit = Number(m.limitMicroCents)
  if (!limit) return 0
  return Math.min(100, (used / limit) * 100)
}

function fmtReset(iso?: string): string {
  if (!iso) return "—"
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return "—"
  const diffMs = target - Date.now()
  if (diffMs <= 0) return "now"
  const totalMin = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin % (60 * 24)) / 60)
  const mins = totalMin % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// ── Network helpers ──────────────────────────────────────────────────────────
// This machine has no global IPv6 route (only a link-local Tailscale tunnel),
// while opencode.ai publishes AAAA records. The runtime fetch can pick the IPv6
// address and fail with "Unable to connect" instead of falling back to IPv4.
// Resolve an A record and retry pinned to that IPv4 address (Host header +
// TLS SNI preserved) when the normal fetch fails.
async function resolveIPv4(host: string): Promise<string | undefined> {
  const g = globalThis as any
  try {
    if (g.Bun?.dns?.lookup) {
      const res = await g.Bun.dns.lookup(host)
      const a = res?.find?.(
        (r: { family: number; address: string }) => r.family === 4,
      )
      if (a?.address) return a.address
    }
  } catch {}
  try {
    const dns = await import("node:dns/promises")
    const res = await dns.lookup(host, { family: 4 })
    if (res?.address) return res.address
  } catch {}
  return undefined
}

async function fetchWithIPv4Fallback(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const host = new URL(url).hostname
    const ip = await resolveIPv4(host)
    if (!ip) throw err
    const u = new URL(url)
    const headers = new Headers(init.headers)
    headers.set("Host", host)
    return await fetch(`https://${ip}${u.pathname}${u.search}`, {
      ...init,
      headers,
      // @ts-ignore Bun-specific: keep TLS SNI/hostname verification on the real host
      tls: { serverName: host },
    })
  }
}

async function scrapeUsage(
  authCookie: string,
  workspaceId: string,
): Promise<{ data?: GoUsageData; error?: string }> {
  try {
    const resp = await fetchWithIPv4Fallback(GO_STATUS_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Origin: "https://opencode.ai",
        Referer: `https://opencode.ai/console/${encodeURIComponent(workspaceId)}/go`,
        Cookie: `__Host-console_session=${authCookie}`,
        "x-org-id": workspaceId,
      },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    })

    if (resp.status === 401 || resp.status === 403) {
      return { error: `Auth ${resp.status} — refresh __Host-console_session cookie` }
    }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` }
    }

    const body = (await resp.json()) as GoStatusResponse
    const meters = body.access?.meters
    if (!meters) {
      return { error: "No meters in /go/status response" }
    }

    const endsAt = body.access?.endsAt
    const raw: {
      key: "fiveHour" | "week" | "month"
      label: string
      meter?: Meter
      reset?: string
    }[] = [
      { key: "fiveHour", label: "Rolling", meter: meters.fiveHour, reset: meters.fiveHour?.resetsAt },
      { key: "week", label: "Weekly", meter: meters.week, reset: meters.week?.resetsAt },
      { key: "month", label: "Monthly", meter: meters.month, reset: meters.month?.resetsAt ?? endsAt },
    ]
    const windows: WindowUsage[] = raw
      .filter((w) => w.meter)
      .map((w) => ({
        key: w.key,
        label: w.label,
        usagePercent: pctOf(w.meter),
        resetText: fmtReset(w.reset),
      }))

    if (windows.length === 0) {
      return { error: "Could not parse usage meters" }
    }

    return { data: { windows } }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (/abort/i.test(msg)) return { error: "Request timed out" }
    return { error: msg }
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function barStr(ratio: number, w: number): string {
  const filled = Math.round(Math.min(Math.max(ratio, 0), 1) * w)
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, w - filled))
}

function fmtPct(n: number): string {
  return `${n.toFixed(0)}%`
}

// Yellow ≥ 50%, red ≥ 80% (user preference for usage plugins).
function circle(pct: number): string {
  return pct >= 80 ? "🔴 " : pct >= 50 ? "🟡 " : ""
}

// ── Plugin ───────────────────────────────────────────────────────────────────
type State =
  | { kind: "loading" }
  | { kind: "error"; msg: string }
  | { kind: "help" }
  | { kind: "data"; d: GoUsageData }

export default Plugin.define({
  id: "opencode.go.usage",

  setup(context) {
    // Durable UI preference (survives restarts, syncs across TUI instances).
    const [prefs, updatePrefs] = context.storage.store("prefs", {
      initial: { expanded: true },
    })

    const [state, setState] = createSignal<State>({ kind: "loading" })

    let timerId: ReturnType<typeof setInterval> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAttempt = 0
    let disposed = false

    async function refresh(): Promise<void> {
      if (disposed) return

      const resolved = await resolveConfig()
      if (!resolved.result) {
        setState({ kind: "help" })
        return
      }

      const scraped = await scrapeUsage(
        resolved.result.authCookie,
        resolved.result.workspaceId,
      )
      if (disposed) return

      if (scraped.error) {
        setState({ kind: "error", msg: scraped.error })
        // Stop the normal interval, then run the self-healing retry chain.
        if (timerId) {
          clearInterval(timerId)
          timerId = undefined
        }
        scheduleRetry(retryAttempt)
        retryAttempt++
        return
      }

      retryAttempt = 0
      setState({ kind: "data", d: scraped.data! })
      // Start the normal interval only after the first success.
      if (!timerId) timerId = setInterval(refresh, REFRESH_INTERVAL_MS)
    }

    function scheduleRetry(attempt: number): void {
      if (retryTimer) clearTimeout(retryTimer)
      // Retry fast for the first few attempts, then keep retrying at the normal
      // refresh cadence forever, so the panel self-heals once the network
      // recovers instead of staying stuck on the error state.
      const delay =
        attempt < RETRY_DELAYS.length ? RETRY_DELAYS[attempt] : REFRESH_INTERVAL_MS
      retryTimer = setTimeout(refresh, delay)
    }

    // Claim the sidebar slot. The render callback reads our signal reactively.
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const fg = context.theme.text.base
        const mu = context.theme.text.muted
        const warn = context.theme.text.feedback.warning.base
        const s = state()
        const e = prefs.expanded

        const toggle = () =>
          updatePrefs((draft) => {
            draft.expanded = !draft.expanded
          })

        if (s.kind === "loading") {
          return (
            <box flexDirection="column">
              <text fg={mu}>OpenCode Go</text>
              <text fg={mu}>Loading…</text>
            </box>
          )
        }

        if (s.kind === "help") {
          return (
            <box flexDirection="column">
              <text fg={warn}>⚠ OpenCode Go</text>
              <text fg={mu}>No config found</text>
              <text fg={mu}>~/.config/opencode/</text>
              <text fg={mu}>  opencode-quota/</text>
              <text fg={mu}>    opencode-go.json</text>
              <text fg={mu}>{'→ {"authCookie": "st_…",'}</text>
              <text fg={mu}>{'   "workspaceId": "wrk_…"}'}</text>
            </box>
          )
        }

        if (s.kind === "error") {
          return (
            <box flexDirection="column">
              <text fg={warn}>⚠ OpenCode Go</text>
              <text fg={mu}>{s.msg}</text>
            </box>
          )
        }

        const d = s.d
        const monthly = d.windows.find((w) => w.key === "month")
        const monthlyPct = monthly ? monthly.usagePercent : 0

        return (
          <box flexDirection="column">
            <box flexDirection="row" justifyContent="space-between" onMouseDown={toggle}>
              <text fg={fg}>{e ? "▼" : "▶"} OpenCode Go</text>
              <text fg={mu}>{fmtPct(monthlyPct)}</text>
            </box>
            {e &&
              d.windows.map((w) => (
                <box flexDirection="column">
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={fg}>{circle(w.usagePercent)}{w.label}</text>
                    <text fg={fg}>{fmtPct(w.usagePercent)} used</text>
                  </box>
                  <text fg={fg}>{barStr(w.usagePercent / 100, 8)} {fmtPct(w.usagePercent)}</text>
                  <text fg={mu}>Reset {w.resetText}</text>
                </box>
              ))}
          </box>
        )
      },
    })

    // Initial fetch — the interval only starts after the first success.
    refresh()

    // Cleanup: runs when the plugin unloads.
    return () => {
      disposed = true
      if (timerId) clearInterval(timerId)
      if (retryTimer) clearTimeout(retryTimer)
      try {
        unregister()
      } catch {}
    }
  },
})
