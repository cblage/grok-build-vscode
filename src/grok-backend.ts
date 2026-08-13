import { isCredentialError } from "./acp-dispatch";
import type { AcpBackend, BackendConfigState, BackendSessionListResult, BackendSpawnOptions } from "./acp-backend";
import type { EffortLevel } from "./acp";
import { grokCliNeedsShell } from "./cli-process";

export function buildGrokAgentArgs(effort?: EffortLevel, sandbox?: string): string[] {
  // Flag order matters:
  // - `--sandbox` is a *top-level* `grok` option (env: GROK_SANDBOX). It must
  //   precede the `agent` subcommand. `grok agent stdio` does not honor
  //   `[sandbox] profile` from config.toml on its own — without this flag,
  //   ACP sessions run with `sandbox_profile: "off"`.
  // - `--reasoning-effort` is an `agent`-level flag, so it must precede the
  //   `stdio` subcommand (after `stdio` the CLI errors "unexpected argument").
  //   Only the values grok actually accepts are offered
  //   (none|minimal|low|medium|high|xhigh); the bogus `max` we used to expose
  //   made grok exit with code 2 (see #3/#4).
  const args: string[] = [];
  if (sandbox) args.push("--sandbox", sandbox);
  args.push("agent");
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

export const grokBackend: AcpBackend = {
  provider: "grok",
  processName: "Grok process",
  usesClientPlanGate: true,
  spawn(options: BackendSpawnOptions) {
    return {
      command: options.cliPath,
      args: buildGrokAgentArgs(options.effort, options.sandbox),
      env: options.env,
      shell: grokCliNeedsShell(options.cliPath),
    };
  },
  normalizeSessionResponse: (response) => response,
  normalizePromptResult: (result) => result,
  normalizeUpdate: (update, meta) => ({ update, meta }),
  normalizePermissionParams: (params) => params,
  setModel(sessionId, modelId, reasoningEffort) {
    return {
      method: "session/set_model",
      params: {
        sessionId,
        modelId,
        ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
      },
    };
  },
  setReasoningEffort(sessionId, modelId, level) {
    return level ? {
      method: "session/set_model",
      params: { sessionId, modelId, _meta: { reasoningEffort: level } },
    } : null;
  },
  setMode(sessionId, modeId) {
    return { method: "session/set_mode", params: { sessionId, modeId } };
  },
  configState(_response, fallback: BackendConfigState) { return fallback; },
  modelSetSucceeded(response) { return !!response?._meta?.model?.Ok; },
  async listSessions(request, cwd): Promise<BackendSessionListResult> {
    return request("session/list", { cwd });
  },
  isCredentialError,
};
