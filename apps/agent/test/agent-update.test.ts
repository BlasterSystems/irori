import { describe, expect, it } from "vitest";
import { buildAgentUpdateArgs, JobManager, type JobEvents } from "../src/jobs.js";

/**
 * IRI-012: the agent-update job builds a systemd-run transient unit that
 * survives the agent's own restart. Pure argv tests + the no-URL guard path
 * (no process is ever spawned here).
 */

function capture(): JobEvents & { out: string[]; done: Array<[string, string, number | null]> } {
  const out: string[] = [];
  const done: Array<[string, string, number | null]> = [];
  return {
    out,
    done,
    onOutput: (_jobId, _seq, line) => out.push(line),
    onDone: (_jobId, status, exitCode) => done.push([_jobId, status, exitCode]),
  };
}

describe("agent-update job (IRI-012)", () => {
  it("builds a transient-unit argv that survives the agent restart", () => {
    const argv = buildAgentUpdateArgs("11111111-2222-3333-4444-555555555555", "ws://hub:3947/agent-ws");
    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--pipe");
    expect(argv).toContain("--wait");
    expect(argv.join(" ")).toContain("--unit=irori-agent-update-");
    expect(argv).toContain("--expand-environment=no");
    expect(argv.join(" ")).toContain("--setenv=IRORI_SERVER_URL=ws://hub:3947/agent-ws");

    const script = argv.at(-1)!;
    expect(script).toContain("curl -fsSL --max-time 300");
    expect(script).toContain('"$BASE/agent/irori-agent.mjs"');
    expect(script).toContain("node --check");
    expect(script).toContain("irori-agent.mjs.bak");
    // The restart severs the pipe: nothing may write after it.
    expect(script.trimEnd().endsWith("systemctl restart irori-agent.service")).toBe(true);
  });

  it("derives the hub HTTP root from the agent's own server URL", () => {
    const script = buildAgentUpdateArgs("j", "wss://hub.example/agent-ws").at(-1)!;
    expect(script).toContain('wss://*) BASE="https://${BASE#wss://}"');
    expect(script).toContain('BASE="${BASE%/agent-ws}"');
  });

  it("fails fast without a hub URL instead of spawning", () => {
    const ev = capture();
    const jobs = new JobManager(() => ({ nasRoot: null, pin: "0", serverUrl: "" }), ev);
    expect(jobs.start("j1", "agent-update", {})).toBe(true);
    expect(ev.out[0]).toContain("no IRORI_SERVER_URL");
    expect(ev.done[0]?.[1]).toBe("failed");
    expect(ev.done[0]?.[0]).toBe("j1");
  });
});
