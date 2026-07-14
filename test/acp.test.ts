import { describe, it, expect, vi } from "vitest";
import { AcpClient, buildGrokAgentArgs } from "../src/acp";

// Unit tests for AcpClient internals that don't need a real subprocess. We
// stand up the client with a fake writable proc and drive `request`/`onLine`
// directly.
function clientWithFakeProc(): { client: AcpClient; written: string[] } {
  const client = new AcpClient({ cliPath: "x", cwd: "/", log: () => {} });
  const written: string[] = [];
  (client as any).proc = {
    killed: false,
    stdin: { writable: true, write: (s: string) => written.push(s) },
  };
  return { client, written };
}

describe("AcpClient.request timer lifecycle", () => {
  it("clears the per-request timeout when the response arrives (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc();
      const before = vi.getTimerCount();

      const p = (client as any).request("session/set_mode", { modeId: "plan" }); // id = 1
      expect(vi.getTimerCount()).toBe(before + 1); // timeout armed

      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      await p;

      expect(vi.getTimerCount()).toBe(before); // timeout cleared on response
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AcpClient execution backend", () => {
  it("awaits an asynchronous terminal backend before acknowledging create", async () => {
    const { client, written } = clientWithFakeProc();
    const create = vi.fn(async () => ({ terminalId: "sandbox-terminal" }));
    client.terminal = {
      create,
      output: async () => ({ output: "", exitStatus: null, truncated: false }),
      waitForExit: async () => ({ exitCode: 0 }),
      kill: async () => {},
      release: async () => {},
    };

    await (client as any).handleServerRequest({
      id: 7,
      method: "terminal/create",
      params: { command: "pwd" },
    });

    expect(create).toHaveBeenCalledWith({ command: "pwd" });
    expect(JSON.parse(written.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { terminalId: "sandbox-terminal" },
    });
  });

  it("disposes its execution backend exactly once", async () => {
    const client = new AcpClient({ cliPath: "x", cwd: "/", log: () => {} });
    const dispose = vi.fn(async () => {});
    client.executionBackend = { dispose };

    await client.dispose();
    await client.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

// #3/#4 (thanks @shugav for the crash report): the startup crash was the bogus
// `max` value, not reasoningEffort itself — grok accepts none|minimal|low|medium|
// high|xhigh, and the flag must precede the `stdio` subcommand.
describe("buildGrokAgentArgs", () => {
  it("starts ACP sessions with the stdio subcommand when no effort is set", () => {
    expect(buildGrokAgentArgs()).toEqual(["agent", "stdio"]);
  });

  it("forwards a valid effort as --reasoning-effort before the stdio subcommand", () => {
    expect(buildGrokAgentArgs("high")).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
    expect(buildGrokAgentArgs("none")).toEqual(["agent", "--reasoning-effort", "none", "stdio"]);
    expect(buildGrokAgentArgs("xhigh")).toEqual(["agent", "--reasoning-effort", "xhigh", "stdio"]);
  });

  it("puts --sandbox before the agent subcommand (top-level grok flag)", () => {
    expect(buildGrokAgentArgs(undefined, "workspace")).toEqual([
      "--sandbox",
      "workspace",
      "agent",
      "stdio",
    ]);
    expect(buildGrokAgentArgs("high", "lumina")).toEqual([
      "--sandbox",
      "lumina",
      "agent",
      "--reasoning-effort",
      "high",
      "stdio",
    ]);
  });

  it("omits --sandbox when the profile is undefined", () => {
    expect(buildGrokAgentArgs("low", undefined)).toEqual([
      "agent",
      "--reasoning-effort",
      "low",
      "stdio",
    ]);
  });
});
