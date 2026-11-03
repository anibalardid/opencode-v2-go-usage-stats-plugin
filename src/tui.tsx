/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { resolveCredentials } from "./credentials"
import { fetchUsage, type GoUsageData } from "./usage"

// ── Config ───────────────────────────────────────────────────────────────────
// The API-key transport (GET /zen/go/v1/usage) is preferred: it reuses the
// credential OpenCode already holds for the `opencode-go` models and needs no
// browser session. The console cookie transport is kept as a fallback.
//
// NOTE: nothing here touches `process` at module top level on purpose. The
// OpenCode 2 TUI sandbox does not expose `process` while the module is
// evaluated, so a top-level `process.env` access aborts plugin initialization
// silently (the plugin is discovered but never renders).
const REFRESH_INTERVAL_MS = 180_000
const RETRY_DELAYS = [60_000, 60_000, 60_000] as const

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
  | { kind: "data"; d: GoUsageData; source: string }

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

      const credentials = await resolveCredentials()
      if (credentials.kind === "none") {
        setState({ kind: "help" })
        return
      }

      const result = await fetchUsage(credentials)
      if (disposed) return

      if (result.error || !result.data) {
        setState({ kind: "error", msg: result.error ?? "Unknown error" })
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
      setState({ kind: "data", d: result.data, source: credentials.source })
      // Start the normal interval only after the first success.
      if (!timerId) timerId = setInterval(refresh, REFRESH_INTERVAL_MS)
    }

    function scheduleRetry(attempt: number): void {
      if (retryTimer) clearTimeout(retryTimer)
      // Retry fast for the first few attempts, then keep retrying at the normal
      // refresh cadence forever, so the panel self-heals once the network
      // recovers instead of staying stuck on the error state.
      const delay = attempt < RETRY_DELAYS.length ? RETRY_DELAYS[attempt] : REFRESH_INTERVAL_MS
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
              <text fg={mu}>No credential found</text>
              <text fg={mu}>Sign in: opencode auth</text>
              <text fg={mu}>or pin it in</text>
              <text fg={mu}>opencode-quota/opencode-go.json</text>
              <text fg={mu}>{'  {"apiKey": "oc_sk_…"}'}</text>
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
            {e && (
              <box flexDirection="column">
                {d.windows.map((w) => (
                  <box flexDirection="column">
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={fg}>
                        {circle(w.usagePercent)}
                        {w.label}
                      </text>
                      <text fg={fg}>{fmtPct(w.usagePercent)} used</text>
                    </box>
                    <text fg={fg}>
                      {barStr(w.usagePercent / 100, 8)} {fmtPct(w.usagePercent)}
                    </text>
                    <text fg={mu}>Reset {w.resetText}</text>
                  </box>
                ))}
                <text fg={mu}>key · {s.source}</text>
              </box>
            )}
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
