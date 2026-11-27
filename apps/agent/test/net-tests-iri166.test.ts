import { describe, expect, it, vi } from "vitest";
import { JOB_KINDS, NET_RESULT_MARKER, netTestResultSchema } from "@irori/core";
import { buildCommand } from "../src/modelctl.js";
import { RUNNER_KINDS } from "../src/jobs.js";
import { fabricAddrsOf, parseIperfJson, parsePingBurst, runNetTestClient, runNetTestServer, type NetTestDeps, type ProcRunner } from "../src/net-tests.js";

/** IRI-166 (ADR-0021): link-test runners — validation first, then iperf3/ping with injected output. */

const FABRIC = [
  { iface: "enp1s0f0np0", ip: "10.100.112.2", subnet: "10.100.112.0/24" },
  { iface: "enP2p1s0f0np0", ip: "10.100.113.2", subnet: "10.100.113.0/24" },
];

const iperfOk = (bps: number, retransmits = 3) => JSON.stringify({ end: { sum_received: { bits_per_second: bps }, sum_sent: { retransmits } } });
const iperfRefused = JSON.stringify({ error: "error - unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection refused" });

function deps(run: ProcRunner): NetTestDeps {
  return { fabricAddrs: async () => FABRIC, run, sleep: async () => {} };
}

const signal = () => new AbortController().signal;

describe("job surface", () => {
  it("registers the kinds; ensure takes no params and the test kinds run as agent code", () => {
    expect(JOB_KINDS).toEqual(expect.arrayContaining(["net-tool-ensure", "net-test-server", "net-test-client"]));
    expect(RUNNER_KINDS.has("net-test-server")).toBe(true);
    expect(RUNNER_KINDS.has("net-test-client")).toBe(true);
    const built = buildCommand("net-tool-ensure", { packages: ["evil"] }, { nasRoot: null, pin: "0.25.0" });
    expect(built.argv[0]).toBe("bash");
    expect(built.argv[2]).toContain("apt-get install -y $NEED");
    expect(built.argv[2]).toContain("NEED=\"$NEED perftest\"");
    expect(built.argv[2]).not.toContain("evil"); // params are ignored, never interpolated
  });
});

describe("runNetTestServer", () => {
  it("refuses an address that is not on a local fabric interface", async () => {
    const run = vi.fn();
    const lines: string[] = [];
    const out = await runNetTestServer({ bindIp: "10.0.10.4", port: 5201, runs: 2, timeoutS: 60 }, (l) => lines.push(l), signal(), deps(run as never));
    expect(out.ok).toBe(false);
    expect(lines[0]).toContain("10.0.10.4 is not an address of a fabric interface");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses out-of-range ports and unknown keys", async () => {
    const lines: string[] = [];
    expect((await runNetTestServer({ bindIp: "10.100.112.2", port: 22, runs: 1, timeoutS: 60 }, (l) => lines.push(l), signal(), deps(vi.fn()))).ok).toBe(false);
    expect((await runNetTestServer({ bindIp: "10.100.112.2", port: 5201, runs: 1, timeoutS: 60, extra: "-D" }, (l) => lines.push(l), signal(), deps(vi.fn()))).ok).toBe(false);
    expect(lines.every((l) => l.startsWith("error: invalid net-test-server params"))).toBe(true);
  });

  it("binds only the fabric address, announces once, serves the requested runs", async () => {
    const calls: string[][] = [];
    const run: ProcRunner = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      opts.onLine?.("-----------------------------------------------------------");
      opts.onLine?.("Server listening on 5203 (test #1)");
      return { code: 0, stdout: "", stderr: "" };
    };
    const lines: string[] = [];
    const out = await runNetTestServer({ bindIp: "10.100.112.2", port: 5203, runs: 2, timeoutS: 60 }, (l) => lines.push(l), signal(), deps(run));
    expect(out.ok).toBe(true);
    expect(calls).toEqual([
      ["stdbuf", "-oL", "iperf3", "-s", "-1", "-B", "10.100.112.2", "-p", "5203"],
      ["stdbuf", "-oL", "iperf3", "-s", "-1", "-B", "10.100.112.2", "-p", "5203"],
    ]);
    expect(lines.filter((l) => l.startsWith("IRORI_NET_LISTENING"))).toEqual(["IRORI_NET_LISTENING enp1s0f0np0 10.100.112.2:5203"]);
  });
});

describe("listener readiness without a flushed status line (review F1)", () => {
  it("announces a listener that is still running after the grace period", async () => {
    // iperf3 on a pipe buffers "Server listening" until exit: the line never comes.
    const run: ProcRunner = async (cmd, args) => {
      expect([cmd, args[0]]).toEqual(["stdbuf", "-oL"]); // line-buffered stdout
      await new Promise((r) => setTimeout(r, 1700));
      return { code: 0, stdout: "", stderr: "" };
    };
    const lines: string[] = [];
    const started = Date.now();
    const out = await runNetTestServer({ bindIp: "10.100.112.2", port: 5203, runs: 1, timeoutS: 60 }, (l) => {
      if (l.startsWith("IRORI_NET_LISTENING")) lines.push(`${Date.now() - started}`);
    }, signal(), deps(run));
    expect(out.ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0])).toBeGreaterThanOrEqual(1400);
  });

  it("does not announce a listener that exits at once (bad address, port taken)", async () => {
    const run: ProcRunner = async () => ({ code: 1, stdout: "", stderr: "iperf3: error - unable to start listener for connections: Address already in use" });
    const lines: string[] = [];
    const out = await runNetTestServer({ bindIp: "10.100.112.2", port: 5203, runs: 1, timeoutS: 60 }, (l) => lines.push(l), signal(), deps(run));
    await new Promise((r) => setTimeout(r, 1600));
    expect(out.ok).toBe(false);
    expect(lines.some((l) => l.startsWith("IRORI_NET_LISTENING"))).toBe(false);
    expect(lines.at(-1)).toContain("Address already in use");
  });
});

describe("runNetTestClient", () => {
  const params = { bindIp: "10.100.112.2", targetIp: "10.100.112.1", port: 5201, durationS: 10, streams: 4, reverse: true, pings: 100 };

  it("refuses a target outside the bind interface's subnet (no flood tool)", async () => {
    const lines: string[] = [];
    const out = await runNetTestClient({ ...params, targetIp: "10.0.10.1" }, (l) => lines.push(l), signal(), deps(vi.fn()));
    expect(out.ok).toBe(false);
    expect(lines[0]).toBe("error: target 10.0.10.1 is not a peer inside 10.100.112.0/24");
    expect((await runNetTestClient({ ...params, durationS: 300 }, () => {}, signal(), deps(vi.fn()))).ok).toBe(false);
    expect((await runNetTestClient({ ...params, streams: 64 }, () => {}, signal(), deps(vi.fn()))).ok).toBe(false);
  });

  it("measures forward and reverse, retries a refused connect, then runs the burst", async () => {
    const calls: string[][] = [];
    let reverseAttempts = 0;
    const run: ProcRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "ping") {
        const lines = Array.from({ length: 98 }, (_, i) => `64 bytes from 10.100.112.1: icmp_seq=${i + 1} ttl=64 time=0.0${(i % 9) + 1} ms`);
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      if (args.includes("-R")) {
        reverseAttempts += 1;
        return { code: 1, stdout: reverseAttempts === 1 ? iperfRefused : iperfOk(93_700_000_000, 1), stderr: "" };
      }
      return { code: 0, stdout: iperfOk(94_210_000_000), stderr: "" };
    };
    const lines: string[] = [];
    const out = await runNetTestClient(params, (l) => lines.push(l), signal(), deps(run));
    expect(out.ok).toBe(true);
    expect(calls[0]).toEqual(["iperf3", "-c", "10.100.112.1", "-B", "10.100.112.2", "-p", "5201", "-J", "-t", "10", "-P", "4"]);
    expect(reverseAttempts).toBe(2);
    expect(calls.at(-1)).toEqual(["ping", "-n", "-c", "100", "-i", "0.01", "-W", "1", "-I", "10.100.112.2", "10.100.112.1"]);
    const resultLine = lines.find((l) => l.startsWith(NET_RESULT_MARKER))!;
    const result = netTestResultSchema.parse(JSON.parse(resultLine.slice(NET_RESULT_MARKER.length)));
    expect(result).toMatchObject({ tool: "iperf3", forwardGbps: 94.21, reverseGbps: 93.7, retransmits: 4, lossPct: 2, durationS: 10, streams: 4, errors: [] });
    expect(result.rttP50Ms).toBeGreaterThan(0);
  });

  it("reports a failed direction in the result instead of throwing", async () => {
    const run: ProcRunner = async (cmd, args) =>
      cmd === "ping" ? { code: 1, stdout: "", stderr: "" } : args.includes("-R") ? { code: 1, stdout: "not json", stderr: "" } : { code: 0, stdout: iperfOk(1e9), stderr: "" };
    const lines: string[] = [];
    const out = await runNetTestClient(params, (l) => lines.push(l), signal(), deps(run));
    expect(out.ok).toBe(true); // forward succeeded
    const result = JSON.parse(lines.at(-1)!.slice(NET_RESULT_MARKER.length));
    expect(result).toMatchObject({ forwardGbps: 1, reverseGbps: null, lossPct: 100, errors: ["reverse: iperf3 output was not JSON"] });
  });
});

describe("parsers and fabric addresses", () => {
  it("parses iperf3 JSON and errors", () => {
    expect(parseIperfJson(iperfOk(12_345_000_000, 0))).toEqual({ gbps: 12.35, retransmits: 0, error: null });
    expect(parseIperfJson(iperfRefused).error).toContain("unable to connect");
    expect(parseIperfJson("{")).toMatchObject({ gbps: null, error: "iperf3 output was not JSON" });
  });

  it("computes burst percentiles and loss", () => {
    const out = ["time=0.030 ms", "time=0.040 ms", "time=0.050 ms", "time=0.900 ms"].join("\n");
    expect(parsePingBurst(out, 5)).toEqual({ p50: 0.04, p99: 0.9, lossPct: 20 });
    expect(parsePingBurst("", 10)).toEqual({ p50: null, p99: null, lossPct: 100 });
  });

  it("lists only fabric IPv4 addresses", () => {
    const detail = new Map([
      ["enp1s0f0np0", { cidrs: ["10.100.112.2/24", "fe80::1/64"] }],
      ["enP7s7", { cidrs: ["10.0.10.4/24"] }],
    ]);
    const facts = new Map([
      ["enp1s0f0np0", { kind: "fabric" }],
      ["enP7s7", { kind: "lan" }],
    ]);
    expect(fabricAddrsOf(detail, facts)).toEqual([{ iface: "enp1s0f0np0", ip: "10.100.112.2", subnet: "10.100.112.0/24", rdma: null }]);
  });
});
