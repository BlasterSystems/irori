import { describe, expect, it, vi } from "vitest";
import {
  createCardHintsService,
  docHostsFromEnv,
  docLinks,
  isAllowedDocUrl,
  parseRunHints,
  pickHints,
  resolveHint,
} from "../src/hf-card-hints.js";

/**
 * IRI-153 (ADR-0020): run hints from the README and allow-listed docs.
 * The docs fixture is the real markup of the "Run Inkling 2 Mini" block on
 * https://unsloth.ai/docs/models/inkling-2-mini (2026-11-21), trimmed of
 * classes; the prose fragment around it is real too (inline <code> flags).
 */
const INKLING_FILES = [
  "README.md",
  "Inkling-2-Mini-UD-Q4_K_M.gguf",
  "Inkling-2-Mini-UD-Q4_K_XL.gguf",
  "dspark-Inkling-2-Mini-Q8_0.gguf",
  "dspark/dspark-Inkling-2-Mini-BF16.gguf",
  "mmproj-BF16.gguf",
  "mmproj-F16.gguf",
  "mmproj-F32.gguf",
].map((path) => ({ path, bytes: null }));

const LINE = (s: string): string =>
  `<span class="highlight-line"><span class="highlight-line-content">${s}</span></span>`;
const INKLING_DOCS_HTML = [
  `<p>Keep <code class="x">llama-server</code> and its bundled libraries together.</p>`,
  `<pre class="relative"><code class="table">`,
  LINE(`./llama.cpp/llama-server \\<!-- -->\n`),
  LINE(`    --model Inkling-2-Mini-GGUF/Inkling-2-Mini-UD-Q4_K_XL.gguf \\<!-- -->\n`),
  LINE(`    --mmproj Inkling-2-Mini-GGUF/mmproj-F16.gguf \\<!-- -->\n`),
  LINE(`    --model-draft Inkling-2-Mini-GGUF/dspark-Inkling-2-Mini-Q8_0.gguf \\<!-- -->\n`),
  LINE(`    --spec-type draft-dspark --spec-draft-n-max 3 --n-gpu-layers-draft 99 \\<!-- -->\n`),
  LINE(`    --host 127.0.0.1 --port 8080`),
  `</code></pre>`,
  `<p>The <code class="x">--model-draft</code> and <code class="x">--spec-type draft-dspark</code> flags turn on DSpark.</p>`,
].join("");

const POWERSHELL = [
  "```powershell",
  ".\\llama.cpp\\llama-server.exe `",
  "    --model Inkling-2-Mini-GGUF\\Inkling-2-Mini-UD-Q4_K_XL.gguf `",
  "    --model-draft Inkling-2-Mini-GGUF/dspark-Inkling-2-Mini-Q8_0.gguf `",
  "    --spec-type draft-dspark",
  "```",
].join("\n");

const README_WITH_LINKS = [
  "# Inkling 2 Mini GGUF",
  "See [our guide](https://unsloth.ai/docs/basics/unsloth-dynamic-v3.0-gguf).",
  "![logo](https://raw.githubusercontent.com/unslothai/unsloth/main/images/logo.png)",
  "Files: https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/tree/main/Mainline_Support",
  "Run it: [Inkling docs](https://unsloth.ai/docs/models/inkling-2-mini)",
  "Evil: https://10.0.0.1/admin https://user:pw@unsloth.ai/x https://unsloth.ai:8443/x http://unsloth.ai/x https://unsloth.ai.evil.com/x",
].join("\n");

describe("parseRunHints / pickHints", () => {
  it("reads the real Inkling docs block, ignoring the inline-code prose around it", () => {
    const picked = pickHints(parseRunHints(INKLING_DOCS_HTML), INKLING_FILES);
    expect(picked).toEqual({
      draft: "dspark-Inkling-2-Mini-Q8_0.gguf",
      mmproj: "mmproj-F16.gguf",
      specType: "draft-dspark",
    });
  });

  it("reads PowerShell backtick continuations", () => {
    expect(pickHints(parseRunHints(POWERSHELL), INKLING_FILES)).toMatchObject({
      draft: "dspark-Inkling-2-Mini-Q8_0.gguf",
      specType: "draft-dspark",
    });
  });

  it("keeps a dflash spec type only alongside a resolved draft", () => {
    const files = [{ path: "m-Q4_K_M.gguf", bytes: null }, { path: "dflash-m-Q8_0.gguf", bytes: null }];
    expect(pickHints(parseRunHints("llama-server -m m-Q4_K_M.gguf -md dflash-m-Q8_0.gguf --spec-type draft-dflash"), files)).toEqual({
      draft: "dflash-m-Q8_0.gguf",
      mmproj: null,
      specType: "draft-dflash",
    });
    // A spec type without a resolvable draft is dropped.
    expect(pickHints(parseRunHints("llama-server --mmproj nope.gguf --spec-type draft-x"), files)).toBeNull();
  });

  it("drops hints that name files outside the repo listing or unsafe spec types", () => {
    const text = "llama-server --model-draft other-repo/evil.gguf --mmproj mmproj-F16.gguf --spec-type '--host=0.0.0.0'";
    expect(pickHints(parseRunHints(text), INKLING_FILES)).toEqual({ draft: null, mmproj: "mmproj-F16.gguf", specType: null });
  });
});

describe("resolveHint", () => {
  it("matches repo-relative suffixes, then unique basenames", () => {
    expect(resolveHint("Inkling-2-Mini-GGUF/dspark/dspark-Inkling-2-Mini-BF16.gguf", INKLING_FILES)).toBe("dspark/dspark-Inkling-2-Mini-BF16.gguf");
    expect(resolveHint("/models/x/MMPROJ-F16.gguf", INKLING_FILES)).toBe("mmproj-F16.gguf");
    expect(resolveHint("./dspark-Inkling-2-Mini-Q8_0.gguf", INKLING_FILES)).toBe("dspark-Inkling-2-Mini-Q8_0.gguf");
    expect(resolveHint("README.md", INKLING_FILES)).toBeNull();
    expect(resolveHint(undefined, INKLING_FILES)).toBeNull();
  });

  it("rejects paths naming another GGUF repo (multi-model docs pages)", () => {
    const files = [{ path: "mmproj-BF16.gguf", bytes: null }];
    expect(resolveHint("unsloth/gemma-4-31B-it-GGUF/mmproj-BF16.gguf", files, "unsloth/gemma-4-26B-A4B-it-GGUF")).toBeNull();
    expect(resolveHint("unsloth/gemma-4-26B-A4B-it-GGUF/mmproj-BF16.gguf", files, "unsloth/gemma-4-26B-A4B-it-GGUF")).toBe("mmproj-BF16.gguf");
    expect(resolveHint("mmproj-BF16.gguf", files, "unsloth/gemma-4-26B-A4B-it-GGUF")).toBe("mmproj-BF16.gguf");
    // The real docs.unsloth.ai/models/gemma-4 page lists several variants: the right one still wins.
    const page = "llama-server --mmproj unsloth/gemma-4-31B-it-GGUF/mmproj-BF16.gguf\nllama-server --mmproj unsloth/gemma-4-26B-A4B-it-GGUF/mmproj-F16.gguf";
    expect(pickHints(parseRunHints(page), [{ path: "mmproj-BF16.gguf", bytes: null }, { path: "mmproj-F16.gguf", bytes: null }], "unsloth/gemma-4-26B-A4B-it-GGUF")).toMatchObject({ mmproj: "mmproj-F16.gguf" });
  });

  it("refuses an ambiguous basename", () => {
    const files = [{ path: "a/x.gguf", bytes: null }, { path: "b/x.gguf", bytes: null }];
    expect(resolveHint("x.gguf", files)).toBeNull();
    expect(resolveHint("repo/b/x.gguf", files)).toBe("b/x.gguf");
  });
});

describe("doc-host allowlist", () => {
  const hosts = docHostsFromEnv(undefined);

  it("accepts only https, default port, no userinfo, no IPs, exact hosts", () => {
    expect(isAllowedDocUrl("https://unsloth.ai/docs/models/inkling-2-mini", hosts)).not.toBeNull();
    for (const bad of [
      "http://unsloth.ai/x",
      "https://unsloth.ai:8443/x",
      "https://user:pw@unsloth.ai/x",
      "https://10.0.0.1/x",
      "https://[::1]/x",
      "https://unsloth.ai.evil.com/x",
      "https://evil.unsloth.ai/x",
      "not a url",
    ]) {
      expect(isAllowedDocUrl(bad, hosts)).toBeNull();
    }
  });

  it("parses the env override; empty disables doc fetches", () => {
    expect(docHostsFromEnv(" A.example , b.example ")).toEqual(["a.example", "b.example"]);
    expect(docHostsFromEnv("")).toEqual([]);
  });

  it("ranks the model's own page first and drops assets, same-repo pages and off-list links", () => {
    const links = docLinks(README_WITH_LINKS, "unsloth/Inkling-2-Mini-GGUF", hosts).map((u) => u.toString());
    expect(links).toEqual([
      "https://unsloth.ai/docs/models/inkling-2-mini",
      "https://unsloth.ai/docs/basics/unsloth-dynamic-v3.0-gguf",
    ]);
  });
});

/** Each route builds a FRESH response per request (cloned bodies tee, and a tee'd cancel waits for the unread branch). */
type Route = () => Response;

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return route();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const text = (body: string, type = "text/plain"): Route => () => new Response(body, { status: 200, headers: { "content-type": type } });
const redirect = (status: number, location: string): Route => () => new Response(null, { status, headers: { location } });
const README_URL = "https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/abc123/README.md";
const DOCS_URL = "https://unsloth.ai/docs/models/inkling-2-mini";
const GUIDE_URL = "https://unsloth.ai/docs/basics/unsloth-dynamic-v3.0-gguf";

describe("createCardHintsService", () => {
  it("falls back to the allow-listed docs page; the HF token never reaches a doc host", async () => {
    const { impl, calls } = fakeFetch({
      [README_URL]: text(README_WITH_LINKS, "text/plain"),
      [DOCS_URL]: text(INKLING_DOCS_HTML, "text/html; charset=utf-8"),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: docHostsFromEnv(undefined) });
    const hints = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES, "hf_secret");
    expect(hints).toEqual({
      draft: "dspark-Inkling-2-Mini-Q8_0.gguf",
      mmproj: "mmproj-F16.gguf",
      specType: "draft-dspark",
      source: "docs",
      url: DOCS_URL,
      error: null,
    });
    const readme = calls.find((c) => c.url === README_URL)!;
    expect((readme.init.headers as Record<string, string>).authorization).toBe("Bearer hf_secret");
    for (const c of calls.filter((c) => !c.url.startsWith("https://huggingface.co/"))) {
      expect(JSON.stringify(c.init.headers)).not.toContain("hf_secret");
      expect(c.init.redirect).toBe("manual");
    }
    // Only the ranked allow-listed links were fetched; the first hit wins.
    expect(calls.map((c) => c.url)).toEqual([README_URL, DOCS_URL]);
  });

  it("prefers README hints and does not fetch docs then", async () => {
    const { impl, calls } = fakeFetch({ [README_URL]: text(`${POWERSHELL}\n${README_WITH_LINKS}`) });
    const svc = createCardHintsService({ fetchImpl: impl });
    const hints = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(hints).toMatchObject({ source: "readme", draft: "dspark-Inkling-2-Mini-Q8_0.gguf" });
    expect(calls).toHaveLength(1);
  });

  it("refuses redirects to hosts off the allowlist and non-text bodies", async () => {
    const { impl, calls } = fakeFetch({
      [README_URL]: text(README_WITH_LINKS),
      [DOCS_URL]: redirect(302, "http://169.254.169.254/latest/meta-data"),
      [GUIDE_URL]: text("%PDF-1.7", "application/pdf"),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: docHostsFromEnv(undefined) });
    const hints = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(hints.draft).toBeNull();
    expect(hints.error).toMatch(/blocked host 169\.254\.169\.254/);
    expect(hints.error).toMatch(/application\/pdf/);
    expect(calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });

  it("follows an allow-listed redirect within the hop limit", async () => {
    const moved = "https://docs.unsloth.ai/models/inkling-2-mini";
    const { impl } = fakeFetch({
      [README_URL]: text(README_WITH_LINKS),
      [DOCS_URL]: redirect(301, moved),
      [moved]: text(INKLING_DOCS_HTML, "text/html"),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: docHostsFromEnv(undefined) });
    expect((await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES)).draft).toBe("dspark-Inkling-2-Mini-Q8_0.gguf");
  });

  it("caps the body: a snippet beyond 2 MiB is not read", async () => {
    const padded = "x".repeat(2 * 1024 * 1024 + 10) + INKLING_DOCS_HTML;
    const { impl } = fakeFetch({ [README_URL]: text(README_WITH_LINKS), [DOCS_URL]: text(padded, "text/html") });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: ["unsloth.ai"] });
    expect((await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES)).draft).toBeNull();
  });

  it("never throws, skips repos without a README, retries failures, caches successes (review F4)", async () => {
    const boom = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const svc = createCardHintsService({ fetchImpl: boom });
    const first = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(first).toMatchObject({ draft: null, error: expect.stringContaining("network down") });
    await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(boom).toHaveBeenCalledTimes(2); // failures are not cached
    const none = await svc.hints("org/no-card", "abc", [{ path: "m.gguf", bytes: null }]);
    expect(none).toEqual({ draft: null, mmproj: null, specType: null, source: null, url: null, error: null });

    let t = 0;
    const { impl, calls } = fakeFetch({ [README_URL]: text(POWERSHELL) });
    const ok = createCardHintsService({ fetchImpl: impl, now: () => t });
    await ok.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    await ok.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(calls).toHaveLength(1);
    t = 11 * 60_000;
    await ok.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(calls).toHaveLength(2);
  });

  it("merges field by field with the README winning, and searches docs until a draft resolves (review F2)", async () => {
    const other = "https://unsloth.ai/docs/models/inkling-2-mini-extra";
    const readme = `llama-server --mmproj mmproj-BF16.gguf\nGuide: ${DOCS_URL} and ${other}`;
    const { impl, calls } = fakeFetch({
      [README_URL]: text(readme),
      [DOCS_URL]: text("llama-server --mmproj mmproj-F16.gguf", "text/html"),
      [other]: text("llama-server --model-draft dspark-Inkling-2-Mini-Q8_0.gguf --spec-type draft-dspark", "text/html"),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: ["unsloth.ai"] });
    const hints = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(hints).toEqual({
      draft: "dspark-Inkling-2-Mini-Q8_0.gguf",
      specType: "draft-dspark",
      mmproj: "mmproj-BF16.gguf", // the README's choice survives
      source: "docs",
      url: other,
      error: null,
    });
    expect(calls.map((c) => c.url)).toEqual([README_URL, DOCS_URL, other]);
  });

  it("keeps a partial README result uncached when a docs page failed (review R1)", async () => {
    let docsUp = false;
    const { impl, calls } = fakeFetch({
      [README_URL]: text(`llama-server --mmproj mmproj-F16.gguf\n${DOCS_URL}`),
      [DOCS_URL]: () =>
        docsUp
          ? new Response("llama-server --model-draft dspark-Inkling-2-Mini-Q8_0.gguf", { status: 200, headers: { "content-type": "text/html" } })
          : new Response("down", { status: 503, headers: { "content-type": "text/plain" } }),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: ["unsloth.ai"] });
    const first = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(first).toMatchObject({ mmproj: "mmproj-F16.gguf", source: "readme", draft: null, error: expect.stringContaining("503") });
    docsUp = true;
    const second = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(second).toMatchObject({ draft: "dspark-Inkling-2-Mini-Q8_0.gguf", mmproj: "mmproj-F16.gguf", error: null });
    expect(calls).toHaveLength(4);
  });

  it("recognises llama-mtmd-cli invocations (review R3)", () => {
    expect(parseRunHints("./llama-mtmd-cli --model m.gguf --mmproj mmproj-BF16.gguf")).toEqual([{ model: "m.gguf", mmproj: "mmproj-BF16.gguf" }]);
  });

  it("reports the docs URL after redirects (review F6)", async () => {
    const moved = "https://docs.unsloth.ai/models/inkling-2-mini";
    const { impl } = fakeFetch({
      [README_URL]: text(README_WITH_LINKS),
      [DOCS_URL]: redirect(301, moved),
      [moved]: text(INKLING_DOCS_HTML, "text/html"),
    });
    const svc = createCardHintsService({ fetchImpl: impl, docHosts: docHostsFromEnv(undefined) });
    expect((await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES)).url).toBe(moved);
  });

  it("enforces one total time budget across hops (review F3)", async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const svc = createCardHintsService({ fetchImpl: hang, budgetMs: 50 });
    const started = Date.now();
    const hints = await svc.hints("unsloth/Inkling-2-Mini-GGUF", "abc123", INKLING_FILES);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hints.error).toMatch(/README unavailable/);
  });
});

describe("adversarial input is linear (review F1 regression)", () => {
  const MiB2 = 2 * 1024 * 1024;
  it.each([
    ["< runs without >", "<".repeat(MiB2)],
    ["<br runs", "<br".repeat(MiB2 / 3)],
    ["link + dots", `https://unsloth.ai/${".".repeat(MiB2)}a`],
    ["dense llama-server", "llama-server ".repeat(MiB2 / 13)],
    ["dense flags", `llama-server ${"-m ".repeat(MiB2 / 3)}`],
    ["fence storm", "```\n".repeat(MiB2 / 4)],
  ])("%s: 2 MiB parses well under a second", (_label, payload) => {
    const started = performance.now();
    parseRunHints(payload);
    docLinks(payload, "unsloth/Inkling-2-Mini-GGUF", ["unsloth.ai"]);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe("invocation scope (review F5/F6)", () => {
  it("ends an invocation at its code block, not in the prose after it", () => {
    const md = "```bash\nllama-server -m a.gguf\n```\nFor the bigger sibling, add --model-draft b-Q8_0.gguf";
    expect(parseRunHints(md)).toEqual([{ model: "a.gguf" }]);
    const html = "<pre><code>llama-server -m a.gguf</code></pre><p>add --model-draft b-Q8_0.gguf</p>";
    expect(parseRunHints(html)).toEqual([{ model: "a.gguf" }]);
  });

  it("only skips the listed repo's own HF pages, not prefix look-alikes", () => {
    const links = docLinks(
      "https://huggingface.co/o/r/tree/main https://huggingface.co/o/r2-docs https://huggingface.co/o/r",
      "o/r",
      ["huggingface.co"],
    ).map(String);
    expect(links).toEqual(["https://huggingface.co/o/r2-docs"]);
  });
});
