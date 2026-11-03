import { z } from "zod";

/**
 * OS / firmware update awareness (IRI-081, epic IR-157 WS5). Irori never
 * installs and never reboots: the value is telling the operator what each
 * node has and what upstream shipped, then leaving the decision to them.
 *
 * On-node truth is the only reliable source — hub-side APT probing was
 * measured dead (every probed repo path 404 / NXDOMAIN, see
 * docs/research/IRI-083-community-topics-research-brief.md), so the agent
 * reports facts and the hub diffs them against a scraped NVIDIA baseline.
 */

/** Baseline components from the NVIDIA DGX Spark release notes. */
export const UPDATE_COMPONENTS = [
  "dgxOs",
  "kernel",
  "nvidiaDriver",
  "uefi",
  "ec",
  "soc",
  "firmwareOther",
] as const;
export const updateComponentSchema = z.enum(UPDATE_COMPONENTS);
export type UpdateComponent = z.infer<typeof updateComponentSchema>;

/** What the agent reads from the node. Every field null = could not read. */
export const nodeUpdateReportSchema = z.object({
  osPrettyName: z.string().nullable().default(null),
  kernelVersion: z.string().nullable().default(null),
  /** DGX OS release (e.g. "7.6.0") from dpkg metadata or the image marker. */
  dgxOsVersion: z.string().nullable().default(null),
  nvidiaDriverVersion: z.string().nullable().default(null),
  /** fwupdmgr results keyed by device id; empty when fwupd is absent. */
  firmware: z
    .record(
      z.string(),
      z.object({
        device: z.string(),
        version: z.string().nullable(),
        /** Newest version fwupd knows about; null when offline/no remote. */
        updateVersion: z.string().nullable().default(null),
      }),
    )
    .default({}),
  /** OTA check tooling installed (nvidia-spark-ota-check / dgx-spark-ota-update-meta). */
  otaToolingInstalled: z.boolean().default(false),
  /** /var/run/reboot-required — the single most actionable flag here. */
  pendingReboot: z.boolean().default(false),
  /** Unattended-upgrades last-run outcome, parsed from its log when readable. */
  unattendedLastResult: z.enum(["ok", "failed", "unknown"]).default("unknown"),
  unattendedLastRun: z.string().nullable().default(null),
  /** Dry-run upgradable count. NEVER an install: the argv builder forbids it. */
  upgradableCount: z.number().int().nonnegative().nullable().default(null),
  /** True when `apt-get -s upgrade` itself failed (no lists, locked, etc.). */
  upgradableError: z.boolean().default(false),
  collectedAt: z.number().int().nonnegative(),
});
export type NodeUpdateReport = z.infer<typeof nodeUpdateReportSchema>;

/** Per-component verdict for one node. */
export const updateStatusSchema = z.object({
  component: updateComponentSchema,
  label: z.string(),
  node: z.string().nullable(),
  baseline: z.string().nullable(),
  status: z.enum(["current", "behind", "unknown", "tooling-missing"]),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** One row of the fleet matrix. */
export const nodeUpdatesSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string(),
  online: z.boolean(),
  pendingReboot: z.boolean(),
  upgradableCount: z.number().int().nonnegative().nullable(),
  upgradableError: z.boolean(),
  otaToolingInstalled: z.boolean(),
  unattendedLastResult: z.enum(["ok", "failed", "unknown"]),
  unattendedLastRun: z.string().nullable(),
  statuses: z.array(updateStatusSchema),
  collectedAt: z.number().int().nullable(),
});
export type NodeUpdates = z.infer<typeof nodeUpdatesSchema>;

/** Scrubbed NVIDIA release-notes baseline (hub-cached, daily). */
export const updateBaselineSchema = z.object({
  /** Founders Edition truth — partner GB10 boards lag; the UI must say so. */
  edition: z.literal("founders"),
  dgxOs: z.string().nullable(),
  kernel: z.string().nullable(),
  nvidiaDriver: z.string().nullable(),
  uefi: z.string().nullable(),
  ec: z.string().nullable(),
  soc: z.string().nullable(),
  releaseNotesUrl: z.string(),
  /** docbuild:last-update meta, the upstream staleness signal. */
  docLastUpdate: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  /** True when the last scrape failed and these are last-known-good values. */
  stale: z.boolean().default(false),
});
export type UpdateBaseline = z.infer<typeof updateBaselineSchema>;

export const updatesResponseSchema = z.object({
  fleet: z.array(nodeUpdatesSchema),
  baseline: updateBaselineSchema,
  /** Forum threads about update pain, linked as context (IRI-083). */
  relatedTopics: z
    .array(z.object({ id: z.string(), title: z.string(), url: z.string(), replies: z.number().int().nonnegative().nullable() }))
    .default([]),
});
export type UpdatesResponse = z.infer<typeof updatesResponseSchema>;
