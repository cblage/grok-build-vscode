import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSeatbeltBrokerArgs, sanitizeBootstrapEnv } from "../src/seatbelt-broker";
import {
  executeBrokerMethod,
  resolveBrokerPath,
  sanitizeSandboxTerminalEnv,
} from "../src/seatbelt-broker-child";
import { TerminalManager } from "../src/terminal-manager";

const nodeEval = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;

describe("Seatbelt broker protocol helpers", () => {
  it("builds sandbox-exec args without shell interpolation", () => {
    expect(buildSeatbeltBrokerArgs("(version 1)", "/Applications/Editor App", "out/child.js", "/work root"))
      .toEqual([
        "-p",
        "(version 1)",
        "/Applications/Editor App",
        path.resolve("out/child.js"),
        path.resolve("/work root"),
      ]);
  });

  it("sanitizes Node and dynamic-loader bootstrap variables", () => {
    const source = {
      PATH: "/bin",
      NODE_OPTIONS: "--require /tmp/hook.js",
      NODE_PATH: "/tmp/modules",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
      DYLD_LIBRARY_PATH: "/tmp/lib",
      ELECTRON_RUN_AS_NODE: "0",
    };
    const env = sanitizeBootstrapEnv(source);
    expect(env).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
    expect(source.NODE_OPTIONS).toBe("--require /tmp/hook.js");
  });

  it("pins child temp variables to the policy's trusted temp root", () => {
    const env = sanitizeBootstrapEnv(
      { TMPDIR: "/repo/tmpdir", TMP: "/repo/tmp", TEMP: "/repo/temp" },
      "/private/var/folders/trusted/T",
    );
    expect(env.TMPDIR).toBe("/private/var/folders/trusted/T");
    expect(env.TMP).toBe("/private/var/folders/trusted/T");
    expect(env.TEMP).toBe("/private/var/folders/trusted/T");
  });

  it("prevents ACP terminal requests from replacing pinned temp variables", () => {
    expect(sanitizeSandboxTerminalEnv([
      { name: "PATH", value: "/bin" },
      { name: "TMPDIR", value: "/repo/tmpdir" },
      { name: "tmp", value: "/repo/tmp" },
      { name: "Temp", value: "/repo/temp" },
    ])).toEqual([{ name: "PATH", value: "/bin" }]);
  });

  it("anchors relative filesystem paths to the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-seatbelt-broker-"));
    const terminals = new TerminalManager();
    try {
      expect(resolveBrokerPath(root, "nested/file.txt")).toBe(path.join(root, "nested", "file.txt"));
      await executeBrokerMethod(
        "fs/write_text_file",
        { path: "nested/file.txt", content: "sandboxed" },
        root,
        terminals,
      );
      await expect(executeBrokerMethod(
        "fs/read_text_file",
        { path: "nested/file.txt" },
        root,
        terminals,
      )).resolves.toBe("sandboxed");
    } finally {
      terminals.disposeAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps wait_for_exit concurrent so kill can settle it", async () => {
    const terminals = new TerminalManager();
    const workspaceRoot = process.cwd();
    try {
      const created = await executeBrokerMethod(
        "terminal/create",
        { command: nodeEval("setInterval(()=>{}, 1000)") },
        workspaceRoot,
        terminals,
      ) as { terminalId: string };
      const waiting = executeBrokerMethod(
        "terminal/wait_for_exit",
        { terminalId: created.terminalId },
        workspaceRoot,
        terminals,
      ) as Promise<{ exitCode: number }>;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await executeBrokerMethod(
        "terminal/kill",
        { terminalId: created.terminalId },
        workspaceRoot,
        terminals,
      );
      const result = await waiting;
      expect(result.exitCode).not.toBe(0);
      await executeBrokerMethod(
        "terminal/release",
        { terminalId: created.terminalId },
        workspaceRoot,
        terminals,
      );
    } finally {
      terminals.disposeAll();
    }
  });
});
