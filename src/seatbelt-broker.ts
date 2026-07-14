import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import * as path from "node:path";
import type { TerminalCreateParams, TerminalOutputResult } from "./terminal-manager";

export type SeatbeltBrokerMethod =
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export interface SeatbeltBrokerRequest {
  id: number;
  method: SeatbeltBrokerMethod;
  params: Record<string, unknown>;
}

interface SeatbeltBrokerResponse {
  id: number;
  result?: unknown;
  error?: { message?: string; code?: string | number };
}

export interface SeatbeltBrokerOptions {
  policy: string;
  workspaceRoot: string;
  childScriptPath: string;
  runtimePath?: string;
  sandboxExecPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Must match the temp root admitted by the compiled policy. */
  trustedTempDir?: string;
  startupTimeoutMs?: number;
  onLog?: (message: string) => void;
  /** Called once when a live broker dies unexpectedly. The host must tear down
   * the matching Grok client rather than falling back to direct execution. */
  onFatal?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type BrokerState = "new" | "starting" | "ready" | "dead" | "disposed";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const STDERR_TAIL_LIMIT = 8_192;

export function sanitizeBootstrapEnv(
  source: NodeJS.ProcessEnv,
  trustedTempDir?: string,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name === "NODE_OPTIONS" || name === "NODE_PATH" || name.startsWith("DYLD_")) {
      delete env[name];
    }
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  if (trustedTempDir) {
    // Child runtimes disagree about which temp variable wins. Pin all three
    // to the exact root compiled into the Seatbelt policy rather than letting
    // a workspace `.env` select an ungranted path.
    env.TMPDIR = trustedTempDir;
    env.TMP = trustedTempDir;
    env.TEMP = trustedTempDir;
  }
  return env;
}

export function buildSeatbeltBrokerArgs(
  policy: string,
  runtimePath: string,
  childScriptPath: string,
  workspaceRoot: string,
): string[] {
  return ["-p", policy, runtimePath, path.resolve(childScriptPath), path.resolve(workspaceRoot)];
}

/**
 * Long-lived macOS Seatbelt process which owns every delegated ACP filesystem
 * and terminal operation for one Grok session. The extension host only sends
 * NDJSON requests over pipes; the broker and all of its command children run
 * under the same irreversible sandbox profile.
 */
export class SeatbeltBroker {
  private state: BrokerState = "new";
  private proc?: ChildProcessWithoutNullStreams;
  private stdoutLines?: ReadlineInterface;
  private stderrLines?: ReadlineInterface;
  private startPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private forceKillTimer?: ReturnType<typeof setTimeout>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail = "";
  private fatalReported = false;

  constructor(private readonly options: SeatbeltBrokerOptions) {
    if (!options.policy.trim()) throw new Error("Seatbelt policy must not be empty");
    if (!options.workspaceRoot) throw new Error("Seatbelt workspace root must not be empty");
    if (!options.childScriptPath) throw new Error("Seatbelt broker child path must not be empty");
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "dead" || this.state === "disposed") {
      throw new Error(`Seatbelt broker cannot start after it is ${this.state}`);
    }
    if (this.startPromise) return this.startPromise;

    this.state = "starting";
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });

    const runtimePath = this.options.runtimePath ?? process.execPath;
    const sandboxExecPath = this.options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC;
    const args = buildSeatbeltBrokerArgs(
      this.options.policy,
      runtimePath,
      this.options.childScriptPath,
      this.options.workspaceRoot,
    );

    try {
      this.proc = spawn(sandboxExecPath, args, {
        cwd: path.resolve(this.options.workspaceRoot),
        env: sanitizeBootstrapEnv(
          this.options.env ?? process.env,
          this.options.trustedTempDir,
        ),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.fail(this.asError(error, "Failed to launch Seatbelt broker"));
      return this.startPromise;
    }

    this.proc.stdin.setDefaultEncoding("utf8");
    this.stdoutLines = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.stderrLines = createInterface({ input: this.proc.stderr, crlfDelay: Infinity });
    this.stdoutLines.on("line", (line) => this.handleLine(line));
    this.stdoutLines.on("close", () => {
      setImmediate(() => {
        if (this.state === "disposed" || this.state === "dead") return;
        const detail = this.stderrTail ? `: ${this.stderrTail.trim()}` : "";
        this.fail(new Error(`Seatbelt broker closed its protocol stream${detail}`));
      });
    });
    this.stderrLines.on("line", (line) => {
      this.appendStderr(line);
      try { this.options.onLog?.(`[Seatbelt broker] ${line}`); } catch { /* logging cannot break isolation */ }
    });
    this.proc.once("error", (error) => this.fail(this.asError(error, "Seatbelt broker failed")));
    this.proc.once("exit", (code, signal) => {
      if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
      if (this.state === "disposed") return;
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const detail = this.stderrTail ? `: ${this.stderrTail.trim()}` : "";
      this.fail(new Error(`Seatbelt broker exited (${reason})${detail}`));
    });

    this.startupTimer = setTimeout(() => {
      this.fail(new Error(`Seatbelt broker did not become ready within ${this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS}ms`));
    }, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    this.startupTimer.unref?.();

    return this.startPromise;
  }

  readonly fsRead = (filePath: string): Promise<string> => this.readTextFile(filePath);
  readonly fsWrite = (filePath: string, content: string): Promise<void> => this.writeTextFile(filePath, content);

  readTextFile(filePath: string): Promise<string> {
    return this.request<string>("fs/read_text_file", { path: filePath });
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await this.request("fs/write_text_file", { path: filePath, content });
  }

  create(params: TerminalCreateParams): Promise<{ terminalId: string }> {
    return this.request("terminal/create", { ...params });
  }

  output(terminalId: string): Promise<TerminalOutputResult> {
    return this.request("terminal/output", { terminalId });
  }

  waitForExit(terminalId: string): Promise<{ exitCode: number }> {
    return this.request("terminal/wait_for_exit", { terminalId });
  }

  async kill(terminalId: string): Promise<void> {
    await this.request("terminal/kill", { terminalId });
  }

  async release(terminalId: string): Promise<void> {
    await this.request("terminal/release", { terminalId });
  }

  dispose(): void {
    if (this.state === "disposed") return;
    const error = new Error("Seatbelt broker disposed");
    this.state = "disposed";
    this.clearStartupTimer();
    this.startReject?.(error);
    this.startResolve = undefined;
    this.startReject = undefined;
    this.rejectPending(error);

    const proc = this.proc;
    if (!proc) return;
    try {
      if (proc.stdin.writable) {
        proc.stdin.write(`${JSON.stringify({ type: "dispose" })}\n`);
        proc.stdin.end();
      }
    } catch {
      // The process is already leaving; the fallback signal below is enough.
    }
    this.forceKillTimer = setTimeout(() => {
      if (proc.exitCode == null && proc.signalCode == null) {
        try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      }
    }, 1_000);
    this.forceKillTimer.unref?.();
    this.stdoutLines?.close();
    this.stderrLines?.close();
  }

  private request<T = unknown>(method: SeatbeltBrokerMethod, params: Record<string, unknown>): Promise<T> {
    if (this.state !== "ready" || !this.proc) {
      return Promise.reject(new Error(`Seatbelt broker is not ready (${this.state})`));
    }
    const id = this.nextId++;
    const request: SeatbeltBrokerRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.proc!.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(this.asError(error, "Failed to send Seatbelt broker request"));
        });
      } catch (error) {
        this.pending.delete(id);
        reject(this.asError(error, "Failed to send Seatbelt broker request"));
      }
    });
  }

  private handleLine(line: string): void {
    let message: { type?: string } & Partial<SeatbeltBrokerResponse>;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error("Seatbelt broker emitted invalid protocol JSON"));
      return;
    }

    if (message.type === "ready") {
      if (this.state !== "starting") return;
      this.state = "ready";
      this.clearStartupTimer();
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      return;
    }

    if (typeof message.id !== "number") {
      this.fail(new Error("Seatbelt broker emitted an invalid protocol message"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "Seatbelt broker request failed");
      if (message.error.code !== undefined) (error as Error & { code?: string | number }).code = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.state === "dead" || this.state === "disposed") return;
    this.state = "dead";
    this.clearStartupTimer();
    this.startReject?.(error);
    this.startResolve = undefined;
    this.startReject = undefined;
    this.rejectPending(error);
    try { this.proc?.kill("SIGTERM"); } catch { /* best effort */ }
    if (!this.fatalReported) {
      this.fatalReported = true;
      this.options.onFatal?.(error);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private appendStderr(line: string): void {
    this.stderrTail = `${this.stderrTail}${this.stderrTail ? "\n" : ""}${line}`;
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LIMIT);
    }
  }

  private asError(value: unknown, prefix: string): Error {
    if (value instanceof Error) return new Error(`${prefix}: ${value.message}`);
    return new Error(`${prefix}: ${String(value)}`);
  }
}
