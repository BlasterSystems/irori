import { createApp } from "vue";
import App from "./App.vue";
import "./assets/irori.css";
import { healthThresholdsSchema } from "@irori/core";
import { setThresholds } from "./thresholds";

// IRI-069: the server's health rules are the single source of truth for UI
// thresholds — pull them once at boot; seed values stand until the API answers.
void fetch("/api/v1/health/thresholds")
  .then((res) => (res.ok ? res.json() : null))
  .then((t: unknown) => {
    const parsed = healthThresholdsSchema.safeParse(t);
    if (parsed.success) setThresholds(parsed.data);
  })
  .catch(() => {});

createApp(App).mount("#app");
