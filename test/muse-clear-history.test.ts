import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { sessionsDirFor } from "../src/sessions";
import { projectProviderKey } from "../src/provider-ui";

afterEach(() => vi.unstubAllEnvs());

it.each([
  { mixed: false, origin: "local" }, { mixed: true, origin: "local" },
  { mixed: false, origin: "remote" }, { mixed: true, origin: "remote" },
])("reports preserved Muse history while clearing supported history ($origin, mixed=$mixed)", async ({ mixed, origin }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "muse-clear-"));
  try {
    vi.stubEnv("GROK_HOME", temp);
    const cwd = path.join(temp, "repo");
    const grokDir = path.join(sessionsDirFor(temp, cwd), "grok-session");
    if (mixed) {
      fs.mkdirSync(grokDir, { recursive: true });
      fs.writeFileSync(path.join(grokDir, "summary.json"), JSON.stringify({ summary: "Keep accurate counts" }));
    }
    const host: any = Object.create(GrokSidebar.prototype);
    const muse = new Session(); muse.provider = "muse"; muse.cwd = cwd; muse.activeSessionId = "muse-session";
    host.pool = new Set([muse]); host.focused = muse;
    host.remoteRepoScope = () => cwd;
    host.remoteClients = { cwd: () => cwd, active: () => muse };
    host.captureRemoteRequester = () => ({ clientId: "client" });
    host.state = { get: (_: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
    host.host = { appendLine: vi.fn(), showErrorMessage: vi.fn() };
    host.localRepoCatalogEntries = () => [{ cwd }];
    host.sessionCwdsForRepo = () => [cwd]; host.sessionCwd = (s: Session) => s.cwd;
    host.sessionHasLiveOwner = () => false; host.reservedSessionIds = () => [];
    host.connectedProviders = () => ["muse"];
    host.museSessionCache = new Map([[projectProviderKey(cwd), [{ id: "muse-session", provider: "muse", cwd }]]]);
    host.codexSessionCache = new Map(); host.claudeSessionCache = new Map(); host.sessionCache = new Map();
    for (const method of ["reportRequester", "disposeSession", "refreshAdapterHistory", "postSessionsList", "sendLocalRepoSessionsPreview", "refreshRemoteRepoPreview", "removeUploadsForSessions", "removePlanReviews"]) {
      host[method] = vi.fn();
    }
    await host.clearAllSessions(cwd, origin, origin === "remote" ? "client" : undefined);
    expect(host.reportRequester).toHaveBeenCalledWith(origin === "remote" ? { clientId: "client" } : undefined, "warning",
      "Muse Code history deletion is not supported, so its conversations were not cleared.");
    expect(host.reportRequester.mock.calls.some((args: unknown[]) => args.includes("No history to clear."))).toBe(false);
    expect(host.disposeSession).not.toHaveBeenCalled();
    expect(host.refreshAdapterHistory).not.toHaveBeenCalled();
    expect(host.museSessionCache.get(projectProviderKey(cwd))).toHaveLength(1);
    expect(host.pool.has(muse)).toBe(true);
    if (mixed) expect(fs.existsSync(grokDir)).toBe(false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
