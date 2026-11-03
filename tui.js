// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";

// src/credentials.ts
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var CREDENTIAL_SQL = "select value from credential where integration_id = ? and active = 1 order by time_updated desc limit 1";
function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function resolveDataHome(env, override) {
  if (override) return override;
  const xdg = optionalString(env.XDG_DATA_HOME);
  return xdg ? xdg : join(homedir(), ".local", "share");
}
function resolveConfigHome(env, override) {
  if (override) return override;
  const xdg = optionalString(env.XDG_CONFIG_HOME);
  return xdg ? xdg : join(homedir(), ".config");
}
function quotaConfigPath(env, override) {
  return join(resolveConfigHome(env, override), "opencode", "opencode-quota", "opencode-go.json");
}
function opencodeDbPath(env, override) {
  return join(resolveDataHome(env, override), "opencode", "opencode.db");
}
function opencodeAuthPath(env, override) {
  return join(resolveDataHome(env, override), "opencode", "auth.json");
}
async function queryCredentialRow(dbPath, integrationId) {
  if (!existsSync(dbPath)) return void 0;
  const loaders = [
    async () => {
      const sqlite = await import("bun:sqlite");
      const db = new sqlite.Database(dbPath, { readonly: true });
      try {
        return db.query(CREDENTIAL_SQL).get(integrationId);
      } finally {
        db.close();
      }
    },
    async () => {
      const specifier = ["node", "sqlite"].join(":");
      const sqlite = await import(
        /* @vite-ignore */
        specifier
      );
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return db.prepare(CREDENTIAL_SQL).get(integrationId);
      } finally {
        db.close();
      }
    }
  ];
  for (const load of loaders) {
    try {
      const row = await load();
      if (row) return row;
    } catch {
    }
  }
  return void 0;
}
function keyFromCredentialValue(value) {
  if (typeof value !== "string") return void 0;
  try {
    const parsed = JSON.parse(value);
    const body = record(parsed);
    return optionalString(body?.key) ?? optionalString(body?.apiKey) ?? optionalString(body?.api_key) ?? optionalString(body?.token);
  } catch {
    return optionalString(value);
  }
}
async function readJson(path) {
  try {
    return { data: JSON.parse(await readFile(path, "utf-8")), missing: false };
  } catch (err) {
    if (err?.code === "ENOENT") return { missing: true };
    return { missing: false, error: err?.message ?? String(err) };
  }
}
async function apiKeyFromDatabase(dbPath) {
  const row = record(await queryCredentialRow(dbPath, "opencode-go"));
  if (!row) return void 0;
  return keyFromCredentialValue(row.value);
}
function apiKeyFromAuthStore(store) {
  const root = record(store);
  for (const entry of ["opencode-go", "opencode"]) {
    const key = optionalString(record(root?.[entry])?.key);
    if (key) return { key, entry };
  }
  return void 0;
}
async function resolveCredentials(inputs = {}) {
  const env = inputs.env ?? process.env;
  const envKey = optionalString(env.OPENCODE_GO_API_KEY) ?? optionalString(env.OPENCODE_API_KEY) ?? optionalString(env.OPENCODE_ZEN_API_KEY);
  if (envKey) return { kind: "api", apiKey: envKey, source: "env" };
  const shared = await readJson(quotaConfigPath(env, inputs.configHome));
  const sharedConfig = record(shared.data);
  const configKey = optionalString(sharedConfig?.apiKey);
  if (configKey) return { kind: "api", apiKey: configKey, source: "config file" };
  const dbKey = await apiKeyFromDatabase(opencodeDbPath(env, inputs.dataHome));
  if (dbKey) return { kind: "api", apiKey: dbKey, source: "opencode auth" };
  const legacy = await readJson(opencodeAuthPath(env, inputs.dataHome));
  const legacyKey = apiKeyFromAuthStore(legacy.data);
  if (legacyKey) {
    return { kind: "api", apiKey: legacyKey.key, source: `auth.json (${legacyKey.entry})` };
  }
  const envWorkspace = optionalString(env.OPENCODE_GO_WORKSPACE_ID);
  const envCookie = optionalString(env.OPENCODE_GO_AUTH_COOKIE);
  if (envWorkspace && envCookie) {
    return { kind: "console", workspaceId: envWorkspace, authCookie: envCookie, source: "env" };
  }
  const sharedWorkspace = optionalString(sharedConfig?.workspaceId);
  const sharedCookie = optionalString(sharedConfig?.authCookie);
  if (sharedWorkspace && sharedCookie) {
    return {
      kind: "console",
      workspaceId: sharedWorkspace,
      authCookie: sharedCookie,
      source: "config file"
    };
  }
  if (shared.error) return { kind: "none", reason: `config file: ${shared.error}` };
  if (envWorkspace || envCookie) {
    return {
      kind: "none",
      reason: `missing ${envWorkspace ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID"}`
    };
  }
  return { kind: "none", reason: "no OpenCode Go credential found" };
}

// src/usage.ts
var USER_AGENT = "opencode-v2-go-usage-stats-plugin/0.2.0";
var REQUEST_TIMEOUT_MS = 1e4;
function resolveOrigin(env = process.env) {
  return (env.OPENCODE_GO_ORIGIN?.trim() || "https://opencode.ai").replace(/\/+$/, "");
}
async function resolveIPv4(host) {
  const g = globalThis;
  try {
    if (g.Bun?.dns?.lookup) {
      const res = await g.Bun.dns.lookup(host);
      const a = res?.find?.((r) => r.family === 4);
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
var HttpError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
};
function describeFailure(status, body) {
  if (status === 401 || status === 403) {
    let code;
    try {
      const parsed = JSON.parse(body);
      code = typeof parsed?.error?.code === "string" ? parsed.error.code : void 0;
    } catch {
    }
    if (code === "api_key_expired") return "API key expired \u2014 sign in again";
    if (code === "authentication_error") return `Auth ${status} \u2014 credential rejected`;
    return `Auth ${status} \u2014 credential rejected`;
  }
  if (status === 429) return "Rate limited (429)";
  return `HTTP ${status}`;
}
async function requestJson(url, headers) {
  const resp = await fetchWithIPv4Fallback(url, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual"
  });
  if (resp.status >= 300 && resp.status < 400) {
    throw new HttpError("Redirected \u2014 unexpected origin", resp.status);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new HttpError(describeFailure(resp.status, body), resp.status);
  }
  return await resp.json();
}
function record2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}
function isoTimestamp(value) {
  if (typeof value !== "string") return void 0;
  return Number.isFinite(Date.parse(value)) ? value : void 0;
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
var API_WINDOWS = [
  { key: "rolling", id: "fiveHour", label: "Rolling" },
  { key: "weekly", id: "week", label: "Weekly" },
  { key: "monthly", id: "month", label: "Monthly" }
];
var CONSOLE_WINDOWS = [
  { key: "fiveHour", id: "fiveHour", label: "Rolling" },
  { key: "week", id: "week", label: "Weekly" },
  { key: "month", id: "month", label: "Monthly" }
];
function parseUsage(payload) {
  const root = record2(payload);
  if (!root) return void 0;
  const usage = record2(root.usage);
  if (usage) {
    const windows = [];
    for (const { key, id, label } of API_WINDOWS) {
      const window = record2(usage[key]);
      const percent = window ? toNumber(window.percent) : null;
      if (percent === null) continue;
      windows.push({
        key: id,
        label,
        usagePercent: clampPercent(percent),
        resetText: fmtReset(isoTimestamp(window?.resetsAt))
      });
    }
    if (windows.length > 0) return { windows };
  }
  const meters = record2(record2(root.access)?.meters);
  if (meters) {
    const periodEnd = isoTimestamp(record2(root.access)?.endsAt);
    const windows = [];
    for (const { key, id, label } of CONSOLE_WINDOWS) {
      const meter = record2(meters[key]);
      if (!meter) continue;
      const used = toNumber(meter.usedMicroCents);
      const limit = toNumber(meter.limitMicroCents);
      if (used === null || limit === null) continue;
      windows.push({
        key: id,
        label,
        usagePercent: clampPercent(limit > 0 ? used / limit * 100 : 0),
        resetText: fmtReset(isoTimestamp(meter.resetsAt) ?? (id === "month" ? periodEnd : void 0))
      });
    }
    if (windows.length > 0) return { windows };
  }
  return void 0;
}
async function fetchUsage(credentials, origin = resolveOrigin()) {
  try {
    let payload;
    if (credentials.kind === "api") {
      payload = await requestJson(`${origin}/zen/go/v1/usage`, {
        Authorization: `Bearer ${credentials.apiKey.trim()}`
      });
    } else if (credentials.kind === "console") {
      const cookie = credentials.authCookie.trim().replace(/;$/, "");
      payload = await requestJson(`${origin}/console/api/go/status`, {
        Cookie: cookie.includes("=") ? cookie : `__Host-console_session=${cookie}`,
        "x-org-id": credentials.workspaceId.trim()
      });
    } else {
      return { error: credentials.reason };
    }
    const data = parseUsage(payload);
    if (!data) return { error: "Unexpected response shape" };
    return { data };
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (/abort|timeout/i.test(msg)) return { error: "Request timed out" };
    return { error: msg };
  }
}

// src/tui.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var REFRESH_INTERVAL_MS = 18e4;
var RETRY_DELAYS = [6e4, 6e4, 6e4];
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
      const credentials = await resolveCredentials();
      if (credentials.kind === "none") {
        setState({ kind: "help" });
        return;
      }
      const result = await fetchUsage(credentials);
      if (disposed) return;
      if (result.error || !result.data) {
        setState({ kind: "error", msg: result.error ?? "Unknown error" });
        if (timerId) {
          clearInterval(timerId);
          timerId = void 0;
        }
        scheduleRetry(retryAttempt);
        retryAttempt++;
        return;
      }
      retryAttempt = 0;
      setState({ kind: "data", d: result.data, source: credentials.source });
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
            /* @__PURE__ */ jsx("text", { fg: mu, children: "No credential found" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "Sign in: opencode auth" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "or pin it in" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: "opencode-quota/opencode-go.json" }),
            /* @__PURE__ */ jsx("text", { fg: mu, children: '  {"apiKey": "oc_sk_\u2026"}' })
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
          e && /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
            d.windows.map((w) => /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
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
            ] })),
            /* @__PURE__ */ jsxs("text", { fg: mu, children: [
              "key \xB7 ",
              s.source
            ] })
          ] })
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
