import { expect, it } from "vitest";
import appSource from "../src/App.vue?raw";
import modalSource from "../src/components/HubSettingsModal.vue?raw";

/**
 * IRI-019 chrome pins: the footer gear opens the Hub settings modal, and the
 * modal keeps the token write-only + tri-state (blank keeps, explicit clear).
 */
it("App.vue exposes the topbar gear opening the Hub settings modal", () => {
  for (const token of ['aria-label="Hub settings"', '<HubSettingsModal v-if="hubSettingsOpen"', "hubSettingsOpen = true"]) {
    expect(appSource).toContain(token);
  }
  // IRI-025: the gear moved to the topbar — it appears before the footer, which no longer has one.
  expect(appSource.indexOf('aria-label="Hub settings"')).toBeLessThan(appSource.indexOf("<footer"));
});

it("HubSettingsModal keeps the token write-only and tri-state", () => {
  for (const token of ['type="password"', "leave blank to keep the current value", "submitToken(null)", "putHfToken", "Clear token", "Save token"]) {
    expect(modalSource).toContain(token);
  }
  // Write-only: the token input binds only the local ref — no server-derived
  // value binding exists (the API never returns the token).
  expect(modalSource).toContain('v-model="token"');
  expect(modalSource).not.toMatch(/:value="(token|configured)/);
});
