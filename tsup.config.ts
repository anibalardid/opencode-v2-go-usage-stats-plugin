import { defineConfig } from "tsup"

// Build the TUI entrypoint to the repo ROOT as `tui.js`.
//
// Why root and not dist/: OpenCode 2 discovers a local plugin DIRECTORY by
// looking for `tui.ts` / `tui.js` at the directory root (it does NOT follow
// `package.json` `exports["./tui"]` for a discovered directory). Keeping the
// built `tui.js` at the root means this repo works both as a discovered plugin
// directory (`<config>/plugins/<name>/`) and as a configured package path.
export default defineConfig({
  entry: ["src/tui.tsx"],
  outDir: ".",
  format: ["esm"],
  dts: true,
  clean: false,
  sourcemap: false,
  external: [
    "@opencode/plugin",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
})
