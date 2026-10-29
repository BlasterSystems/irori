/**
 * Shared ADR-0011 cache-user runuser wrap: transfers (IR-101), local ops
 * (IRI-028), MODEL_PATH resolution (IR-120), and serve execution (IRI-045)
 * all run a per-user child the same way. The wrap scrubs the root agent's
 * ambient HF/XDG state and pins the owner's HOME, so per-user defaults
 * (modelctl registration state, HF cache) resolve to that user. Pure argv —
 * no shell — keeps the ADR's command-injection mitigation.
 */

/** Env vars scrubbed for every cache-user child (the ADR-0011 set). */
const SCRUBBED = ["XDG_STATE_HOME", "HF_HOME", "HF_HUB_CACHE"] as const;

/**
 * Builds the runuser argv: `runuser -u <user> -- env -u <scrubbed…>
 * HOME=<home> <assignments…> <inner…>`. Assignment order is insertion order;
 * the modelctl shape puts PATH first.
 */
export function runuserWrap(
  user: string,
  home: string,
  assignments: Record<string, string>,
  inner: string[],
): string[] {
  return [
    "runuser",
    "-u",
    user,
    "--",
    "env",
    ...SCRUBBED.flatMap((name) => ["-u", name]),
    `HOME=${home}`,
    ...Object.entries(assignments).map(([key, value]) => `${key}=${value}`),
    ...inner,
  ];
}
