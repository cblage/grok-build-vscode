import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { TerminalManager, type TerminalCreateParams } from "./terminal-manager";
import type { SeatbeltBrokerMethod, SeatbeltBrokerRequest } from "./seatbelt-broker";

interface BrokerError {
  message: string;
  code?: string | number;
}

const PINNED_TEMP_ENV_KEYS = new Set(["TEMP", "TMP", "TMPDIR"]);

/** ACP terminal requests may add environment variables, but must not replace
 * the trusted temp root pinned when the broker was launched. Filtering here
 * keeps TerminalManager reusable for unsandboxed sessions. */
export function sanitizeSandboxTerminalEnv(
  env: TerminalCreateParams["env"],
): TerminalCreateParams["env"] {
  if (!Array.isArray(env)) return env;
  return env.filter((entry) => !PINNED_TEMP_ENV_KEYS.has(entry.name.toUpperCase()));
}

export function resolveBrokerPath(workspaceRoot: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(workspaceRoot, candidate);
}

export async function executeBrokerMethod(
  method: SeatbeltBrokerMethod,
  params: Record<string, unknown>,
  workspaceRoot: string,
  terminals: TerminalManager,
): Promise<unknown> {
  switch (method) {
    case "fs/read_text_file": {
      const filePath = resolveBrokerPath(workspaceRoot, requiredString(params.path, "path"));
      return fs.readFile(filePath, "utf8");
    }
    case "fs/write_text_file": {
      const filePath = resolveBrokerPath(workspaceRoot, requiredString(params.path, "path"));
      const content = requiredString(params.content, "content", true);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return {};
    }
    case "terminal/create": {
      const terminalParams = params as unknown as TerminalCreateParams;
      requiredString(terminalParams.command, "command");
      return terminals.create({
        ...terminalParams,
        env: sanitizeSandboxTerminalEnv(terminalParams.env),
        cwd: terminalParams.cwd
          ? resolveBrokerPath(workspaceRoot, terminalParams.cwd)
          : workspaceRoot,
      });
    }
    case "terminal/output":
      return terminals.output(requiredString(params.terminalId, "terminalId"));
    case "terminal/wait_for_exit":
      return terminals.waitForExit(requiredString(params.terminalId, "terminalId"));
    case "terminal/kill":
      terminals.kill(requiredString(params.terminalId, "terminalId"));
      return {};
    case "terminal/release":
      terminals.release(requiredString(params.terminalId, "terminalId"));
      return {};
    default:
      throw new Error(`Unsupported Seatbelt broker method: ${String(method)}`);
  }
}

export function startSeatbeltBrokerChild(workspaceArg = process.argv[2]): void {
  const workspaceRoot = path.resolve(requiredString(workspaceArg, "workspace root"));
  const terminals = new TerminalManager();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminals.disposeAll();
    lines.close();
    process.stdin.pause();
    process.exitCode = exitCode;
    // TerminalManager escalates process-group termination after 500ms. Keep
    // the broker alive long enough for that fail-safe before exiting.
    setTimeout(() => process.exit(exitCode), 750);
  };

  lines.on("line", (line) => {
    let request: SeatbeltBrokerRequest | { type: "dispose" };
    try {
      request = JSON.parse(line);
    } catch {
      process.stderr.write("Seatbelt broker received invalid protocol JSON\n");
      shutdown(1);
      return;
    }
    if ("type" in request && request.type === "dispose") {
      shutdown();
      return;
    }
    if (!isBrokerRequest(request)) {
      process.stderr.write("Seatbelt broker received an invalid request\n");
      shutdown(1);
      return;
    }

    void executeBrokerMethod(request.method, request.params, workspaceRoot, terminals)
      .then((result) => writeResponse({ id: request.id, result }))
      .catch((error) => writeResponse({ id: request.id, error: serializeError(error) }));
  });
  lines.once("close", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  process.once("SIGINT", () => shutdown());
  process.stdout.once("error", () => shutdown(1));
  process.once("uncaughtException", (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    shutdown(1);
  });
  process.once("unhandledRejection", (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    shutdown(1);
  });

  writeResponse({ type: "ready" });
}

function isBrokerRequest(value: SeatbeltBrokerRequest | { type: "dispose" }): value is SeatbeltBrokerRequest {
  const request = value as Partial<SeatbeltBrokerRequest>;
  return typeof request.id === "number"
    && typeof request.method === "string"
    && request.params !== null
    && typeof request.params === "object";
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function serializeError(value: unknown): BrokerError {
  if (value instanceof Error) {
    const code = (value as Error & { code?: string | number }).code;
    return code === undefined ? { message: value.message } : { message: value.message, code };
  }
  return { message: String(value) };
}

function writeResponse(value: unknown): void {
  if (!process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (require.main === module) startSeatbeltBrokerChild();
