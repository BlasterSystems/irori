import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../src/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyToClipboard", () => {
  it("writes via the async clipboard and returns true", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard("irn_token")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("irn_token");
  });

  it("returns false when no clipboard is available", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyToClipboard("irn_token")).resolves.toBe(false);
  });

  it("falls back to execCommand when navigator.clipboard is absent (insecure origin)", async () => {
    vi.stubGlobal("navigator", {});
    const ta = { value: "", style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ta),
      body: { appendChild: vi.fn() },
      execCommand,
    });
    await expect(copyToClipboard("irn_token")).resolves.toBe(true);
    expect(ta.value).toBe("irn_token");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(ta.remove).toHaveBeenCalled();
  });

  it("returns false when neither clipboard nor execCommand is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { execCommand: undefined });
    await expect(copyToClipboard("irn_token")).resolves.toBe(false);
  });

  it("returns false when the write is denied", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    await expect(copyToClipboard("irn_token")).resolves.toBe(false);
  });
});
