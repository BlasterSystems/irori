import { build } from "esbuild";

const pkg = await import("./package.json", { with: { type: "json" } });

await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  outfile: new URL("./dist/irori-agent.mjs", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  // ws is CJS and requires node builtins dynamically; ESM output needs a real
  // require for that (see esbuild docs on ESM + node interop).
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  define: { __AGENT_VERSION__: JSON.stringify(pkg.default.version) },
  // Optional native accelerators of ws; absent installs fall back cleanly.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});
