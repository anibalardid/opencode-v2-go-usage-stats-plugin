/**
 * Talking to OpenCode Go.
 *
 * Two transports, one result shape:
 *
 *   API key  GET <origin>/zen/go/v1/usage       Authorization: Bearer <key>
 *            { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *
 *   console  GET <origin>/console/api/go/status Cookie + x-org-id
 *            { access: { endsAt, meters: { fiveHour|week|month: {
 *                usedMicroCents, limitMicroCents, resetsAt } } } }
 *
 * Percentages are reported by the API-key endpoint and derived from micro-cents
 * on the console endpoint.
 */

import type { Credentials } from "./credentials"

export type WindowKey = "fiveHour" | "week" | "month"

export interface WindowUsage {
  key: WindowKey
  label: string
  usagePercent: number
  resetText: string
}

export interface GoUsageData {
  windows: WindowUsage[]
}

const USER_AGENT = "opencode-v2-go-usage-stats-plugin/0.2.0"
const REQUEST_TIMEOUT_MS = 10_000

export function resolveOrigin(env: Record<string, string | undefined> = process.env): string {
  return (env.OPENCODE_GO_ORIGIN?.trim() || "https://opencode.ai").replace(/\/+$/, "")
}

// ── Networking ───────────────────────────────────────────────────────────────

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
      const a = res?.find?.((r: { family: number; address: string }) => r.family === 4)
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

async function fetchWithIPv4Fallback(url: string, init: RequestInit): Promise<Response> {
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

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function describeFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    let code: string | undefined
    try {
      const parsed = JSON.parse(body)
      code = typeof parsed?.error?.code === "string" ? parsed.error.code : undefined
    } catch {}
    if (code === "api_key_expired") return "API key expired — sign in again"
    if (code === "authentication_error") return `Auth ${status} — credential rejected`
    return `Auth ${status} — credential rejected`
  }
  if (status === 429) return "Rate limited (429)"
  return `HTTP ${status}`
}

async function requestJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const resp = await fetchWithIPv4Fallback(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual",
  })

  if (resp.status >= 300 && resp.status < 400) {
    throw new HttpError("Redirected — unexpected origin", resp.status)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new HttpError(describeFailure(resp.status, body), resp.status)
  }
  return await resp.json()
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
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

const API_WINDOWS: ReadonlyArray<{ key: string; id: WindowKey; label: string }> = [
  { key: "rolling", id: "fiveHour", label: "Rolling" },
  { key: "weekly", id: "week", label: "Weekly" },
  { key: "monthly", id: "month", label: "Monthly" },
]

const CONSOLE_WINDOWS: ReadonlyArray<{ key: string; id: WindowKey; label: string }> = [
  { key: "fiveHour", id: "fiveHour", label: "Rolling" },
  { key: "week", id: "week", label: "Weekly" },
  { key: "month", id: "month", label: "Monthly" },
]

export function parseUsage(payload: unknown): GoUsageData | undefined {
  const root = record(payload)
  if (!root) return undefined

  // API-key shape: percentages are served directly.
  const usage = record(root.usage)
  if (usage) {
    const windows: WindowUsage[] = []
    for (const { key, id, label } of API_WINDOWS) {
      const window = record(usage[key])
      const percent = window ? toNumber(window.percent) : null
      if (percent === null) continue
      windows.push({
        key: id,
        label,
        usagePercent: clampPercent(percent),
        resetText: fmtReset(isoTimestamp(window?.resetsAt)),
      })
    }
    if (windows.length > 0) return { windows }
  }

  // Console shape: micro-cents per meter, percentage has to be derived.
  const meters = record(record(root.access)?.meters)
  if (meters) {
    const periodEnd = isoTimestamp(record(root.access)?.endsAt)
    const windows: WindowUsage[] = []
    for (const { key, id, label } of CONSOLE_WINDOWS) {
      const meter = record(meters[key])
      if (!meter) continue
      const used = toNumber(meter.usedMicroCents)
      const limit = toNumber(meter.limitMicroCents)
      if (used === null || limit === null) continue
      windows.push({
        key: id,
        label,
        usagePercent: clampPercent(limit > 0 ? (used / limit) * 100 : 0),
        resetText: fmtReset(isoTimestamp(meter.resetsAt) ?? (id === "month" ? periodEnd : undefined)),
      })
    }
    if (windows.length > 0) return { windows }
  }

  return undefined
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function fetchUsage(
  credentials: Credentials,
  origin = resolveOrigin(),
): Promise<{ data?: GoUsageData; error?: string }> {
  try {
    let payload: unknown

    if (credentials.kind === "api") {
      payload = await requestJson(`${origin}/zen/go/v1/usage`, {
        Authorization: `Bearer ${credentials.apiKey.trim()}`,
      })
    } else if (credentials.kind === "console") {
      const cookie = credentials.authCookie.trim().replace(/;$/, "")
      payload = await requestJson(`${origin}/console/api/go/status`, {
        Cookie: cookie.includes("=") ? cookie : `__Host-console_session=${cookie}`,
        "x-org-id": credentials.workspaceId.trim(),
      })
    } else {
      return { error: credentials.reason }
    }

    const data = parseUsage(payload)
    if (!data) return { error: "Unexpected response shape" }
    return { data }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (/abort|timeout/i.test(msg)) return { error: "Request timed out" }
    return { error: msg }
  }
}
