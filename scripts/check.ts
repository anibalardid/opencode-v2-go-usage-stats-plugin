/**
 * Diagnostic: resolve the credential the panel would use, then make the real
 * request and print what the sidebar would show. Never prints the key.
 *
 *   npx tsx scripts/check.ts      # or: bun scripts/check.ts
 */

import { resolveCredentials } from "../src/credentials"
import { fetchUsage, resolveOrigin } from "../src/usage"

const credentials = await resolveCredentials()
console.log("origin:", resolveOrigin())

if (credentials.kind === "none") {
  console.log("credentials: none —", credentials.reason)
  process.exit(1)
}

console.log(`credentials: ${credentials.kind} · ${credentials.source}`)

const result = await fetchUsage(credentials)
if (result.error || !result.data) {
  console.log("error:", result.error ?? "unknown")
  process.exit(1)
}

for (const w of result.data.windows) {
  console.log(`  ${w.label.padEnd(8)} ${w.usagePercent.toFixed(0).padStart(4)}%  reset ${w.resetText}`)
}
