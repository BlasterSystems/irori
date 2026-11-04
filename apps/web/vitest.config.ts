import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

/**
 * IRI-084: stable coverage denominator — `all: true` + explicit include so
 * adding tests can never shrink the measured set (v8 otherwise reports only
 * the files a run happens to import). Unloaded files count at 0%, which
 * makes the number monotonic under the ratchet policy.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
