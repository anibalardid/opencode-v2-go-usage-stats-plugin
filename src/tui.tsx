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

const SHORT: Record<GoUsageData["windows"][number]["key"], string> = {
  fiveHour: "5h",
  week: "wk",
  month: "mo",
}

function heat<T>(pct: number, ok: T, warn: T, bad: T): T {
  if (pct >= 80) return bad
  if (pct >= 50) return warn
  return ok
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
        const s = state()
        if (s.kind !== "data") {
          const text = s.kind === "loading" ? "Go: loading…" : s.kind === "help" ? "Go: not connected" : `Go: ${s.msg}`
          return <text fg={s.kind === "loading" ? mu : context.theme.text.feedback.warning.base}>{text}</text>
        }
        return (
          <box flexDirection="row">
            <text fg={fg}>Go</text>
            {s.d.windows.map((w, i) => (
              <box flexDirection="row">
                <text fg={mu}>{i === 0 ? " " : " · "}</text>
                <text fg={heat(w.usagePercent, context.theme.text.feedback.success.base, context.theme.text.feedback.warning.base, context.theme.text.feedback.error.base)}>●</text>
                <text fg={fg}> {SHORT[w.key]} {Math.round(w.usagePercent)}%</text>
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
