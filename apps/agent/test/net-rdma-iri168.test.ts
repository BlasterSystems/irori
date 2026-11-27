import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NET_RESULT_MARKER, netTestClientParamsSchema, netTestServerParamsSchema } from "@irori/core";
import { ipv4Gid, parseIbSendLat, parseIbWriteBw, runNetTestClient, runNetTestServer, sysfsRdmaGid, type NetTestDeps, type ProcRunner } from "../src/net-tests.js";

/** IRI-168 (ADR-0021): RDMA link tests with perftest (ib_write_bw, ib_send_lat). */

const WRITE_BW = `
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : rocep1s0f0
 Link type       : Ethernet
 GID index       : 3
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      3553280          0.00               186.33  		   0.355398
---------------------------------------------------------------------------------------
`;
const SEND_LAT = `
 #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec]
 2       1000          1.63           5.21         1.68               1.70             0.08            2.04                   5.21
`;

const FABRIC = [{ iface: "enp1s0f0np0", ip: "10.100.112.2", subnet: "10.100.112.0/24", rdma: { device: "rocep1s0f0", port: 1 } }];
const deps = (run: ProcRunner, gid: number | null = 3): NetTestDeps => ({ fabricAddrs: async () => FABRIC, run, sleep: async () => {}, rdmaGid: async () => gid });
const signal = () => new AbortController().signal;

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("contracts", () => {
  it("keeps each tool inside its own port range", () => {
    const base = { bindIp: "10.100.112.2", runs: 2, timeoutS: 60 };
    expect(netTestServerParamsSchema.safeParse({ ...base, tool: "rdma", port: 18515 }).success).toBe(true);
    expect(netTestServerParamsSchema.safeParse({ ...base, tool: "rdma", port: 5201 }).success).toBe(false);
    expect(netTestServerParamsSchema.safeParse({ ...base, tool: "iperf3", port: 18515 }).success).toBe(false);
    expect(netTestClientParamsSchema.safeParse({ bindIp: "10.100.112.2", targetIp: "10.100.112.1", port: 18520, durationS: 10, streams: 1, reverse: false, pings: 0, tool: "rdma" }).success).toBe(true);
  });
});

describe("parsers", () => {
  it("reads the BW average and the latency percentiles", () => {
    expect(parseIbWriteBw(WRITE_BW)).toBe(186.33);
    expect(parseIbWriteBw("Couldn't connect to 10.100.112.1:18515")).toBeNull();
    expect(parseIbSendLat(SEND_LAT)).toEqual({ p50: 0.00168, p99: 0.00204 });
    expect(parseIbSendLat("")).toEqual({ p50: null, p99: null });
  });

  it("finds the RoCE v2 GID of an address in sysfs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "irori-gid-"));
    roots.push(root);
    const base = path.join(root, "class", "infiniband", "rocep1s0f0", "ports", "1");
    mkdirSync(path.join(base, "gids"), { recursive: true });
    mkdirSync(path.join(base, "gid_attrs", "types"), { recursive: true });
    const set = (n: number, gid: string, type: string) => {
      writeFileSync(path.join(base, "gids", String(n)), `${gid}\n`);
      writeFileSync(path.join(base, "gid_attrs", "types", String(n)), `${type}\n`);
    };
    set(0, "fe80:0000:0000:0000:3aa7:46ff:fe5a:1b6f", "IB/RoCE v1");
    set(2, ipv4Gid("10.100.112.2"), "IB/RoCE v1");
    set(3, ipv4Gid("10.100.112.2"), "RoCE v2");
    expect(ipv4Gid("10.100.112.2")).toBe("0000:0000:0000:0000:0000:ffff:0a64:7002");
    expect(await sysfsRdmaGid(root)("rocep1s0f0", 1, "10.100.112.2")).toBe(3);
    expect(await sysfsRdmaGid(root)("rocep1s0f0", 1, "10.100.113.2")).toBeNull();
    expect(await sysfsRdmaGid(root)("missing", 1, "10.100.112.2")).toBeNull();
  });
});

describe("RDMA runners", () => {
  it("serves ib_write_bw then ib_send_lat on the port's GID and announces once", async () => {
    const calls: string[][] = [];
    const run: ProcRunner = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      opts.onLine?.(" Waiting for client to connect... *");
      return { code: 0, stdout: "", stderr: "" };
    };
    const lines: string[] = [];
    const out = await runNetTestServer({ tool: "rdma", bindIp: "10.100.112.2", port: 18517, runs: 2, timeoutS: 80 }, (l) => lines.push(l), signal(), deps(run));
    expect(out.ok).toBe(true);
    expect(calls).toEqual([
      ["stdbuf", "-oL", "ib_write_bw", "-d", "rocep1s0f0", "-i", "1", "-x", "3", "-F", "-p", "18517", "--report_gbits", "-D", "10"],
      ["stdbuf", "-oL", "ib_send_lat", "-d", "rocep1s0f0", "-i", "1", "-x", "3", "-F", "-p", "18517", "-n", "1000"],
    ]);
    expect(lines.filter((l) => l.startsWith("IRORI_NET_LISTENING"))).toHaveLength(1);
  });

  it("refuses without an RDMA device or a RoCE v2 GID", async () => {
    const lines: string[] = [];
    const noGid = await runNetTestServer({ tool: "rdma", bindIp: "10.100.112.2", port: 18517, runs: 2, timeoutS: 80 }, (l) => lines.push(l), signal(), deps(async () => ({ code: 0, stdout: "", stderr: "" }), null));
    expect(noGid.ok).toBe(false);
    expect(lines[0]).toBe("error: no RoCE v2 GID for 10.100.112.2 on rocep1s0f0");
  });

  it("measures write bandwidth and send latency, retrying a refused rendezvous", async () => {
    let bwTries = 0;
    const run: ProcRunner = async (cmd) => {
      if (cmd === "ib_write_bw") {
        bwTries += 1;
        return bwTries === 1 ? { code: 1, stdout: " Couldn't connect to 10.100.112.1:18517", stderr: "" } : { code: 0, stdout: WRITE_BW, stderr: "" };
      }
      return { code: 0, stdout: SEND_LAT, stderr: "" };
    };
    const lines: string[] = [];
    const out = await runNetTestClient(
      { tool: "rdma", bindIp: "10.100.112.2", targetIp: "10.100.112.1", port: 18517, durationS: 10, streams: 1, reverse: false, pings: 0 },
      (l) => lines.push(l),
      signal(),
      deps(run),
    );
    expect(out.ok).toBe(true);
    expect(bwTries).toBe(2);
    const result = JSON.parse(lines.at(-1)!.slice(NET_RESULT_MARKER.length));
    expect(result).toEqual({ tool: "rdma", forwardGbps: 186.33, reverseGbps: null, retransmits: null, rttP50Ms: 0.00168, rttP99Ms: 0.00204, lossPct: null, durationS: 10, streams: 1, errors: [] });
  });
});
