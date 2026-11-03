import { createApp } from "vue";
import App from "./App.vue";
import "./assets/irori.css";
import { setThresholds } from "./thresholds";

// IRI-069: the server's health rules are the single source of truth for UI
// thresholds — pull them once at boot; seed values stand until the API answers.
void fetch("/api/v1/health/thresholds")
  .then((res) => (res.ok ? res.json() : null))
  .then((t: unknown) => {
    if (t !== null && typeof t === "object") setThresholds(t as { tempWarnC: number; tempCriticalC: number; diskWarnPct: number });
  })
  .catch(() => {});

createApp(App).mount("#app");
