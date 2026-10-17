/**
 * Agent version. esbuild injects the package.json version via the
 * __AGENT_VERSION__ define when bundling (see build.mjs); outside the bundle
 * (vitest, tsc) we fall back to a dev marker so wire schemas still validate.
 */
declare const __AGENT_VERSION__: string;

export const AGENT_VERSION: string =
  typeof __AGENT_VERSION__ === "string" && __AGENT_VERSION__.length > 0
    ? __AGENT_VERSION__
    : "0.0.0-dev";
