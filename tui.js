// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
var SCRAPE_TIMEOUT_MS = 1e4;
var REFRESH_INTERVAL_MS = 18e4;
var RETRY_DELAYS = [6e4, 6e4, 6e4];
async function resolveConfig() {
  const envAuth = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  const envWs = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  if (envAuth && envWs) {
    return { result: { authCookie: envAuth, workspaceId: envWs, source: "env" } };
  }
  if (envAuth || envWs) {
    return {
      error: `Missing ${envAuth ? "OPENCODE_GO_WORKSPACE_ID" : "OPENCODE_GO_AUTH_COOKIE"}`
    };
  }
  const configPath = (process.env.HOME ?? "") + "/.config/opencode/opencode-quota/opencode-go.json";
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(content);
    const authCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
    const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
    if (authCookie && workspaceId) {
      return { result: { authCookie, workspaceId, source: configPath } };
    }
    return {
      error: `Incomplete config: missing ${authCookie ? "workspaceId" : "authCookie"}`
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { error: "no config found" };
    }
    return { error: `Error reading config: ${err.message}` };
  }
}
function pctOf(m) {
  if (!m) return 0;
  const used = Number(m.usedMicroCents);
  const limit = Number(m.limitMicroCents);
  if (!limit) return 0;
  return Math.min(100, used / limit * 100);
}
function fmtReset(iso) {
  if (!iso) return "\u2014";
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return "\u2014";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "now";
  const totalMin = Math.floor(diffMs / 6e4);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor(totalMin % (60 * 24) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
async function resolveIPv4(host) {
  const g = globalThis;
  try {
    if (g.Bun?.dns?.lookup) {
      const res = await g.Bun.dns.lookup(host);
      const a = res?.find?.(
        (r) => r.family === 4
      );
      if (a?.address) return a.address;
    }
  } catch {
  }
  try {
    const dns = await import("dns/promises");
    const res = await dns.lookup(host, { family: 4 });
    if (res?.address) return res.address;
  } catch {
  }
  return void 0;
}
async function fetchWithIPv4Fallback(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const host = new URL(url).hostname;
    const ip = await resolveIPv4(host);
    if (!ip) throw err;
    const u = new URL(url);
    const headers = new Headers(init.headers);
    headers.set("Host", host);
    return await fetch(`https://${ip}${u.pathname}${u.search}`, {
      ...init,
      headers,
      // @ts-ignore Bun-specific: keep TLS SNI/hostname verification on the real host
      tls: { serverName: host }
    });
  }
}
async function scrapeUsage(authCookie, workspaceId) {
  try {
    const resp = await fetchWithIPv4Fallback(GO_STATUS_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Origin: "https://opencode.ai",
        Referer: `https://opencode.ai/console/${encodeURIComponent(workspaceId)}/go`,
        Cookie: `__Host-console_session=${authCookie}`,
        "x-org-id": workspaceId
      },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS)
    });
    if (resp.status === 401 || resp.status === 403) {
      return { error: `Auth ${resp.status} \u2014 refresh __Host-console_session cookie` };
    }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` };
    }
    const body = await resp.json();
    const meters = body.access?.meters;
    if (!meters) {
      return { error: "No meters in /go/status response" };
    }
    const endsAt = body.access?.endsAt;
    const raw = [
      { key: "fiveHour", label: "Rolling", meter: meters.fiveHour, reset: meters.fiveHour?.resetsAt },
      { key: "week", label: "Weekly", meter: meters.week, reset: meters.week?.resetsAt },
      { key: "month", label: "Monthly", meter: meters.month, reset: meters.month?.resetsAt ?? endsAt }
    ];
    const windows = raw.filter((w) => w.meter).map((w) => ({
      key: w.key,
      label: w.label,
      usagePercent: pctOf(w.meter),
      resetText: fmtReset(w.reset)
    }));
    if (windows.length === 0) {
      return { error: "Could not parse usage meters" };
    }
    return { data: { windows } };
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (/abort/i.test(msg)) return { error: "Request timed out" };
    return { error: msg };
  }
}
function barStr(ratio, w) {
  const filled = Math.round(Math.min(Math.max(ratio, 0), 1) * w);
  return "\u2588".repeat(Math.max(0, filled)) + "\u2591".repeat(Math.max(0, w - filled));
}
function fmtPct(n) {
  return `${n.toFixed(0)}%`;
}
function circle(pct) {
  return pct >= 80 ? "\u{1F534} " : pct >= 50 ? "\u{1F7E1} " : "";
}
var tui_default = Plugin.define({
  id: "opencode.go.usage",
  setup(context) {
    const [prefs, updatePrefs] = context.storage.store("prefs", {
      initial: { expanded: true }
    });
    const [state, setState] = createSignal({ kind: "loading" });
    let timerId;
    let retryTimer;
    let retryAttempt = 0;
    let disposed = false;
    async function refresh() {
      if (disposed) return;
      const resolved = await resolveConfig();
      if (!resolved.result) {
        setState({ kind: "help" });
        return;
      }
      const scraped = await scrapeUsage(
        resolved.result.authCookie,
        resolved.result.workspaceId
      );
      if (disposed) return;
      if (scraped.error) {
        setState({ kind: "error", msg: scraped.error });
        if (timerId) {
          clearInterval(timerId);
          timerId = void 0;
        }
        scheduleRetry(retryAttempt);
        retryAttempt++;
        return;
      }
      retryAttempt = 0;
      setState({ kind: "data", d: scraped.data });
      if (!timerId) timerId = setInterval(refresh, REFRESH_INTERVAL_MS);
    }
    function scheduleRetry(attempt) {
      if (retryTimer) clearTimeout(retryTimer);
      const delay = attempt < RETRY_DELAYS.length ? RETRY_DELAYS[attempt] : REFRESH_INTERVAL_MS;
      retryTimer = setTimeout(refresh, delay);
    }
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const fg = context.theme.text.base;
        const mu = context.theme.text.muted;
        const warn = context.theme.text.feedback.warning.base;
        const s = state();
        const e = prefs.expanded;
        const toggle = () => updatePrefs((draft) => {
          draft.expanded = !draft.expanded;
        });
        if (s.kind === "loading") {
          return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
            /* @__PURE__ */ jsx("text", { fg: mu, children: "OpenCode Go" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "Loading\u2026" })
          ] });
        }
        if (s.kind === "help") {
          return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
            /* @__PURE__ */ jsx("text", { fg: warn, children: "\u26A0 OpenCode Go" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "No config found" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "~/.config/opencode/" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "  opencode-quota/" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "    opencode-go.json" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: '\u2192 {"authCookie": "st_\u2026",' }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: '   "workspaceId": "wrk_\u2026"}' })
          ] });
        }
        if (s.kind === "error") {
          return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
            /* @__PURE__ */ jsx("text", { fg: warn, children: "\u26A0 OpenCode Go" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: s.msg })
          ] });
        }
        const d = s.d;
        const monthly = d.windows.find((w) => w.key === "month");
        const monthlyPct = monthly ? monthly.usagePercent : 0;
        return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
          /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", onMouseDown: toggle, children: [
            /* @__PURE__ */ jsxs("text", { fg, children: [
              e ? "\u25BC" : "\u25B6",
              " OpenCode Go"
            ] }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: fmtPct(monthlyPct) })
          ] }),
          e && d.windows.map((w) => /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
            /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", children: [
              /* @__PURE__ */ jsxs("text", { fg, children: [
                circle(w.usagePercent),
                w.label
              ] }),
              /* @__PURE__ */ jsxs("text", { fg, children: [
                fmtPct(w.usagePercent),
                " used"
              ] })
            ] }),
            /* @__PURE__ */ jsxs("text", { fg, children: [
              barStr(w.usagePercent / 100, 8),
              " ",
              fmtPct(w.usagePercent)
            ] }),
            /* @__PURE__ */ jsxs("text", { fg: mu, children: [
              "Reset ",
              w.resetText
            ] })
          ] }))
        ] });
      }
    });
    refresh();
    return () => {
      disposed = true;
      if (timerId) clearInterval(timerId);
      if (retryTimer) clearTimeout(retryTimer);
      try {
        unregister();
      } catch {
      }
    };
  }
});
export {
  tui_default as default
};
