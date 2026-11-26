/**
 * IRI-156: the Add-node install block must hand out wss:// when the hub is
 * reached over https (TLS reverse proxy), since ws:// gets a 301 that
 * WebSocket clients do not follow.
 */
import { describe, expect, it } from "vitest";
import { agentWsUrl, hubHttpBase } from "../src/agent-urls";

describe("agentWsUrl", () => {
  it("uses wss:// on https pages", () => {
    expect(agentWsUrl({ protocol: "https:", host: "irori.example.com" })).toBe("wss://irori.example.com/agent-ws");
  });

  it("keeps ws:// on plain-http LAN pages, port included", () => {
    expect(agentWsUrl({ protocol: "http:", host: "10.0.10.9:3947" })).toBe("ws://10.0.10.9:3947/agent-ws");
  });

  it("falls back to a placeholder without a location", () => {
    expect(agentWsUrl(undefined)).toBe("ws://<server>:3947/agent-ws");
  });
});

describe("hubHttpBase", () => {
  it("mirrors the page scheme and host", () => {
    expect(hubHttpBase({ protocol: "https:", host: "irori.example.com" })).toBe("https://irori.example.com");
    expect(hubHttpBase({ protocol: "http:", host: "10.0.10.9:3947" })).toBe("http://10.0.10.9:3947");
  });

  it("falls back to a placeholder without a location", () => {
    expect(hubHttpBase(undefined)).toBe("http://<server>:3947");
  });
});
