import { describe, expect, it } from "vitest";
import modelsViewSource from "../src/components/ModelsView.vue?raw";
import { readFileSync } from "node:fs";
import { COMPANIONS_UNREADABLE_LABEL, companionChips, companionRows, companionsUnreadable, installedSpecType } from "../src/model-companions";

const cssSource = readFileSync(new URL("../src/assets/irori.css", import.meta.url), "utf8");

/** IRI-155: the Models page's companion rows and chips. */

const INKLING = {
  mmproj: { path: "mmproj-F16.gguf", bytes: 644_245_094 },
  draft: { path: "dspark-Inkling-2-Mini-Q8_0.gguf", bytes: 429_496_730, specType: null },
};

describe("companionRows", () => {
  it("renders the Inkling projector and DSpark draft with the effective spec type", () => {
    expect(companionRows(INKLING)).toEqual([
      { label: "projector", text: "mmproj-F16.gguf · 0.6 GiB" },
      { label: "draft", text: "DSpark · dspark-Inkling-2-Mini-Q8_0.gguf · 0.4 GiB · --spec-type draft-dspark" },
    ]);
  });

  it("prefers a recorded spec type, and omits an unknown size and kind", () => {
    const rows = companionRows({ mmproj: null, draft: { path: "drafts/x.gguf", bytes: null, specType: "draft-eagle" } });
    expect(rows).toEqual([{ label: "draft", text: "drafts/x.gguf · --spec-type draft-eagle" }]);
  });

  it("omits --spec-type for a DFlash draft (modelctl serves it with --model-draft only)", () => {
    const rows = companionRows({ mmproj: null, draft: { path: "dflash-x.gguf", bytes: 1024 ** 3, specType: null } });
    expect(rows).toEqual([{ label: "draft", text: "DFlash · dflash-x.gguf · 1.0 GiB" }]);
  });

  it("shows nothing for unknown and known-none", () => {
    expect(companionRows(undefined)).toEqual([]);
    expect(companionRows(null)).toEqual([]);
    expect(companionRows({ mmproj: null, draft: null })).toEqual([]);
  });

  it("installedSpecType mirrors modelctl effective_spec_type", () => {
    expect(installedSpecType({ path: "MTP/mtp-x.gguf", bytes: null, specType: null })).toBe("draft-mtp");
    expect(installedSpecType({ path: "dspark-x.gguf", bytes: null, specType: "draft-mtp" })).toBe("draft-mtp");
  });
});

describe("unreadable (owner decision: the info marker replaces any earlier value)", () => {
  const UNREADABLE = { unreadable: true } as const;

  it("renders no rows and no chips, only the marker", () => {
    expect(companionRows(UNREADABLE)).toEqual([]);
    expect(companionChips(UNREADABLE)).toEqual([]);
    expect(companionsUnreadable(UNREADABLE)).toBe(true);
  });

  it("is never claimed for unknown, none, or readable companions", () => {
    for (const c of [undefined, null, INKLING]) expect(companionsUnreadable(c)).toBe(false);
  });

  it("names the NAS in its label", () => {
    expect(COMPANIONS_UNREADABLE_LABEL).toBe("Cannot read the model's companion info from the NAS");
  });
});

describe("companionChips", () => {
  it("chips only what is installed, naming the file on hover", () => {
    expect(companionChips(INKLING)).toEqual([
      { label: "+draft", title: "draft: dspark-Inkling-2-Mini-Q8_0.gguf" },
      { label: "+mmproj", title: "projector: mmproj-F16.gguf" },
    ]);
    expect(companionChips({ mmproj: INKLING.mmproj, draft: null }).map((c) => c.label)).toEqual(["+mmproj"]);
    expect(companionChips(null)).toEqual([]);
    expect(companionChips(undefined)).toEqual([]);
  });
});

describe("ModelsView markup", () => {
  it("drops the Runtime column but keeps the runtime filter and the drawer chip", () => {
    expect(modelsViewSource).toContain('<th>Model</th><th class="num">Size</th><th>Added</th><th></th>');
    expect(modelsViewSource).not.toContain("<th>Runtime</th>");
    expect(modelsViewSource).not.toContain('<td class="mono">{{ m.runtime }}</td>');
    expect(modelsViewSource).toContain('aria-label="Runtime filters"');
    expect(modelsViewSource).toContain('<span v-if="drawerRuntime !== null" class="chip">{{ drawerRuntime }}</span>');
  });

  it("renders companion chips in the Model cell and kv rows in the drawer, as text only", () => {
    expect(modelsViewSource).toContain('v-for="c in companionChips(m.companions)"');
    expect(modelsViewSource).toContain('<template v-for="c in drawerCompanions" :key="c.label"><dt>{{ c.label }}</dt><dd class="mono">{{ c.text }}</dd></template>');
    expect(modelsViewSource).not.toMatch(/v-html="[^"]*(companion|c\.text|c\.title)/);
  });

  it("shows an accessible, keyboard-reachable info marker in the list row and the drawer", () => {
    const marker = 'class="tip companion-info" tabindex="0" role="img" :aria-label="COMPANIONS_UNREADABLE_LABEL" :data-tip="COMPANIONS_UNREADABLE_LABEL"';
    expect(modelsViewSource.split(marker).length - 1).toBe(2);
    expect(modelsViewSource).toContain('<span v-if="companionsUnreadable(m.companions)" @click.stop>');
    expect(modelsViewSource).toContain('<template v-if="drawerCompanionsUnreadable"><dt>companions</dt><dd>');
    expect(cssSource).toContain(".tip:focus-visible::after { display: block; }");
  });
});
