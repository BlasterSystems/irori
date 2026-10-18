import { z } from "zod";
import { catalogModelSchema } from "./catalog.js";

/** Server → agent: run one job (one active per node enforced by the server). */
export const jobRequestMsgSchema = z.object({
  type: z.literal("job"),
  jobId: z.string().uuid(),
  kind: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const jobCancelMsgSchema = z.object({
  type: z.literal("job-cancel"),
  jobId: z.string().uuid(),
});

/** Server → agent: refresh + report the store catalog (read-only). */
export const catalogRequestMsgSchema = z.object({
  type: z.literal("catalog-request"),
});

/** Agent → server: one output line for a running job. */
export const jobOutputMsgSchema = z.object({
  type: z.literal("job-output"),
  jobId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  line: z.string(),
});

/** Agent → server: job finished. */
export const jobDoneMsgSchema = z.object({
  type: z.literal("job-done"),
  jobId: z.string().uuid(),
  status: z.enum(["succeeded", "failed", "canceled"]),
  exitCode: z.number().int().nullable(),
});

/** Agent → server: store catalog entries (catalog.json or live scan). */
export const catalogMsgSchema = z.object({
  type: z.literal("catalog"),
  source: z.enum(["catalog", "scan"]),
  entries: z.array(catalogModelSchema),
});

export const agentServerMsgSchema = z.discriminatedUnion("type", [
  jobOutputMsgSchema,
  jobDoneMsgSchema,
  catalogMsgSchema,
]);

export type AgentServerMsg = z.infer<typeof agentServerMsgSchema>;
export type JobRequestMsg = z.infer<typeof jobRequestMsgSchema>;
export type JobCancelMsg = z.infer<typeof jobCancelMsgSchema>;
export type CatalogRequestMsg = z.infer<typeof catalogRequestMsgSchema>;
export type JobOutputMsg = z.infer<typeof jobOutputMsgSchema>;
export type JobDoneMsg = z.infer<typeof jobDoneMsgSchema>;
export type CatalogMsg = z.infer<typeof catalogMsgSchema>;
