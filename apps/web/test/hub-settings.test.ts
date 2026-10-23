import { expect, it } from "vitest";
import appSource from "../src/App.vue?raw";
import modalSource from "../src/components/HubSettingsModal.vue?raw";

/**
 * IRI-019 chrome pins: the footer gear opens the Hub settings modal, and the
 * modal keeps the token write-only + tri-state (blank keeps, explicit clear).
 */
it("App.vue exposes the footer gear opening the Hub settings modal", () => {
  for (const token of ['aria-label="Hub settings"', '<HubSettingsModal v-if="hubSettingsOpen"', "hubSettingsOpen = true"]) {
    expect(appSource).toContain(token);
  }
});

it("HubSettingsModal keeps the token write-only and tri-state", () => {
  for (const token of ['type="password"', "leave blank to keep the current value", "submit(null)", "putHfToken", "Clear token", "Save token"]) {
    expect(modalSource).toContain(token);
  }
  // Write-only: the token input binds only the local ref — no server-derived
  // value binding exists (the API never returns the token).
  expect(modalSource).toContain('v-model="token"');
  expect(modalSource).not.toContain(":value=");
});
