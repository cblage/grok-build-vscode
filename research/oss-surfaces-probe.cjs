// OSS-surfaces probe — do the shipped binary's surfaces match the open-sourced
// tree (github.com/xai-org/grok-build)?  The public source revealed several ACP
// surfaces our extension either works around or doesn't use; the tree is "at
// least as new as 0.2.101" and may be AHEAD of what `x.ai/cli/install.ps1`
// ships, so every client change should be confirmed against the REAL binary
// here first. This is a DIAGNOSTIC, not a pass/fail gate — every scenario exits
// 0 and prints evidence for a human to read; it asserts nothing. Promote the
// load-bearing checks into scripts/live-tests.cjs when they must gate a release.
// IMPORTANT: ACP extension methods are `_`-prefixed on the wire
// (`_x.ai/session/list`); a bare `x.ai/...` is rejected `-32601` at the decoder,
// so a bare-method failure proves nothing about whether the RPC ships. Read
// alongside research/grok-build-oss-findings.md.
//
// One scenario per process (like plan-mode-recheck-probe.cjs) so env-per-scenario
// stays clean and captures don't cross-contaminate. Server→client method NAMES
// are counted generically in every scenario, so an unexpected rail shows up
// regardless of which scenario asked for it.
//
//   sessionrpc  (≈free, 0 model turns) — §2.6. Are x.ai/session/{list,info,
//               rename,delete} live and unadvertised?  Params from the source:
//               list {cwd?,query?,limit?} → {rows[](sessionKind,cwd,…),nextCursor};
//               info {sessionId}; rename {sessionId,title,cwd?}; delete
//               {sessionId,cwd?}. Creates a throwaway session in a temp cwd,
//               lists it, renames it, re-lists to confirm, deletes it, confirms
//               the dir is gone. Nothing outside the temp cwd is touched.
//   effort      (≈free, 0 model turns) — §2.7. Does session/new advertise
//               models[]._meta.reasoningEffort/supportsReasoningEffort, and does
//               session/set_model accept a _meta.reasoningEffort override live
//               (no error, ModelChanged echoes it)?
//   notify      (costs credits) — §2.3/§2.4/§2.5. Subscribe to ALL inbound and
//               drive a /compact (deterministic) + a best-effort subagent spawn.
//               Does x.ai/session_notification arrive LIVE with
//               AutoCompactCompleted{tokens_after} / SubagentFinished{duration_ms,
//               tokens_used}?  (We route _x.ai/session/update today, the
//               disk/replay-only tag — this confirms the live rail.)
//   planoutcome (costs credits) — §2.1. Reply to x.ai/exit_plan_mode with a
//               SUCCESS {outcome:"cancelled"} (NOT the JSON-RPC error we send
//               today, which the CLI reads as a disconnect). Does mode stay
//               [plan] and the model treat it as "revise", not a tool failure?
//   rules       (1 short turn) — §2.6 primer relocation. Does session/new
//               _meta.rules actually reach the model?  Rule tells it to answer a
//               nonce; we check the reply.
//   shell       (1 short turn) — §2.9. Spawn with GROK_SHELL=<--shell> and read
//               back the first user message's `Shell:` line from chat_history.jsonl.
//               Run with --shell=powershell and --shell=bash to diff.
//   interject   (costs credits) — #52 "Steer". The router lists x.ai/interject
//               (the TUI's Ctrl+L) but NOBODY has probed it. Starts a long turn,
//               and WITHOUT awaiting it fires (a) a second session/prompt — the
//               control: does a concurrent prompt error, queue, or corrupt? — and
//               (b) _x.ai/interject in four candidate param shapes until one is
//               accepted. -32601 = method absent; -32602 = method EXISTS, shape
//               wrong (still a win — we then know to hunt the shape). Finally asks
//               the model whether it actually saw the interjected text, which is
//               the only proof steering reached the MODEL and not just the router.
//   fork        (≈free, 0 model turns) — #48 branching. Seeds a session with 2
//               turns, forks it via _x.ai/session/fork, then checks the fork got a
//               NEW id, a real dir on disk, and — the load-bearing part — that the
//               forked session's chat_history.jsonl carries the PARENT's history
//               (a fork that loses history is just session/new).
//   usage       (costs credits) — #53 donut breakdown. The ONLY unexplored token
//               surface: turn_completed.usage on the live rail. Dumps the FULL
//               payload of every turn_completed + the prompt result _meta side by
//               side, so we can see whether usage carries a session-CUMULATIVE
//               split (what the donut needs) or just per-turn billing (what
//               promptComplete._meta already gives us).
//
// SAFETY: cwd is a throwaway mkdtemp, never the real repo. terminal/create is
// ACKed with a fake terminal and empty output — no command executes. Writes are
// allowed only inside the temp cwd or grok's own plan.md; anything else is
// refused. delete only ever targets the session THIS probe created.
//
// Usage:
//   node research/oss-surfaces-probe.cjs --scenario=sessionrpc
//   node research/oss-surfaces-probe.cjs --scenario=effort
//   node research/oss-surfaces-probe.cjs --scenario=notify
//   node research/oss-surfaces-probe.cjs --scenario=planoutcome
//   node research/oss-surfaces-probe.cjs --scenario=rules
//   node research/oss-surfaces-probe.cjs --scenario=shell --shell=powershell
//   node research/oss-surfaces-probe.cjs --scenario=interject
//   node research/oss-surfaces-probe.cjs --scenario=fork
//   node research/oss-surfaces-probe.cjs --scenario=usage
//   (optional: GROK_BIN=/path/to/grok, --json for a machine-readable tail)

const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SCENARIO = arg("scenario", "sessionrpc");
const SHELL_PREF = arg("shell", "");
const AS_JSON = argv.includes("--json");
const VALID = ["sessionrpc", "effort", "notify", "planoutcome", "rules", "shell", "interject", "fork", "usage"];
if (!VALID.includes(SCENARIO)) {
  console.error(`unknown --scenario=${SCENARIO}; expected one of ${VALID.join(", ")}`);
  process.exit(2);
}

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

// ── throwaway workspace ──────────────────────────────────────────────────────
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `grok-oss-${SCENARIO}-`)));
fs.writeFileSync(path.join(cwd, "app.js"), "function add(a, b) {\n  return a + b;\n}\n");
fs.writeFileSync(path.join(cwd, "README.md"), "# demo\n");

function log(s) {
  process.stderr.write(`[oss:${SCENARIO}] ${s}\n`);
}

// ── ACP plumbing ─────────────────────────────────────────────────────────────
const childEnv = { ...process.env };
if (SCENARIO === "shell" && SHELL_PREF) childEnv.GROK_SHELL = SHELL_PREF;
const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: childEnv });
let nextId = 1;
const waiters = new Map();
let textBuf = "";

// Every server→client method name, counted. This is the generic net that catches
// x.ai/session_notification (or anything else) regardless of scenario.
const inboundMethods = {};
// Full x.ai/session_notification payloads (the live rail under test).
const xaiNotifications = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondErr(id, code, message) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
proc.stderr.on("data", () => {});
proc.on("error", (e) => {
  log("SPAWN ERROR " + e.message);
  process.exit(2);
});

const isInside = (p, root) => {
  const rel = path.relative(root, path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const isPlanMd = (p) => /[\\/]\.grok[\\/]sessions[\\/].*plan\.md$/i.test(p);

// For planoutcome: reply cancelled to exit_plan_mode instead of a JSON-RPC error.
let planReplyOutcome = "cancelled";
const exitPlanCalls = [];
const modeUpdates = [];
const permissionRequests = [];

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // ── server → client requests ──
  if (msg.method && msg.id != null) {
    const m = msg.method;
    inboundMethods[m] = (inboundMethods[m] || 0) + 1;

    if (m === "fs/read_text_file") {
      let content = "";
      try {
        content = fs.readFileSync(msg.params.path, "utf8");
      } catch {}
      return respond(msg.id, { content });
    }
    if (m === "fs/write_text_file") {
      const p = msg.params.path;
      const body = msg.params.content || "";
      if (isInside(p, cwd) || (isPlanMd(p) && !isInside(p, REPO_ROOT))) {
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, body);
        } catch {}
        return respond(msg.id, {});
      }
      return respondErr(msg.id, -32010, "probe sandbox: out-of-workspace write refused");
    }
    if (m === "terminal/create") return respond(msg.id, { terminalId: "t" + nextId });
    if (m === "terminal/output")
      return respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    if (m === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
    if (m.startsWith("terminal/")) return respond(msg.id, {});

    if (m.includes("exit_plan_mode")) {
      exitPlanCalls.push({ method: m, params: msg.params });
      log(`EXIT_PLAN_MODE method=${m} → replying SUCCESS {outcome:"${planReplyOutcome}"}`);
      return respond(msg.id, { outcome: planReplyOutcome, feedback: "Please revise: keep it to two steps." });
    }
    if (m === "session/request_permission") {
      const opts = (msg.params && msg.params.options) || [];
      permissionRequests.push({ title: msg.params?.toolCall?.title });
      const allow = opts.find((o) => /allow/.test(o.kind)) || opts[0];
      return respond(msg.id, { outcome: { outcome: "selected", optionId: allow && allow.optionId } });
    }
    if (/ask_user_question/.test(m)) return respond(msg.id, { outcome: "cancelled" });
    return respond(msg.id, {});
  }

  // ── notifications ──
  if (msg.method) {
    inboundMethods[msg.method] = (inboundMethods[msg.method] || 0) + 1;
    if (/session_notification|session\/update/.test(msg.method) && msg.method !== "session/update") {
      const u = (msg.params && (msg.params.update || msg.params)) || {};
      xaiNotifications.push({ method: msg.method, update: u });
      const kind = u.sessionUpdate || (u.update && u.update.sessionUpdate) || Object.keys(u).join(",");
      log(`XAI-NOTIFY ${msg.method}  kind=${JSON.stringify(kind).slice(0, 80)}`);
    }
    if (msg.method === "session/update") {
      const u = (msg.params && msg.params.update) || {};
      if (u.sessionUpdate === "current_mode_update") {
        modeUpdates.push(u.currentModeId);
        log(`MODE → ${u.currentModeId}`);
      } else if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        textBuf += u.content.text;
      }
    }
    return;
  }

  if (msg.id != null) {
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
const PROMPT_TIMEOUT = 600000;
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms)),
  ]);
}
async function initAndNew(newMeta) {
  const init = await withTimeout(
    send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    }),
    60000,
    "initialize",
  );
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  const params = { cwd, mcpServers: [] };
  if (newMeta) params._meta = newMeta;
  const ns = await withTimeout(send("session/new", params), 120000, "session/new");
  if (ns.error) throw new Error("session/new: " + JSON.stringify(ns.error));
  return ns.result;
}
async function prompt(sessionId, text, label) {
  textBuf = "";
  const r = await withTimeout(send("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), PROMPT_TIMEOUT, label);
  return { stop: r.result?.stopReason, err: r.error, text: textBuf.trim(), meta: r.result?._meta };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Block until the in-flight turn is demonstrably streaming, so a mid-turn RPC
 *  really lands mid-turn and not in the gap before the model starts. */
async function waitForLiveTurn(label, minChars = 20, ms = 90000) {
  const t0 = Date.now();
  while (textBuf.length < minChars && Date.now() - t0 < ms) await sleep(200);
  log(`${label}: turn live after ${Date.now() - t0}ms (${textBuf.length} chars streamed)`);
  return textBuf.length >= minChars;
}
function readHistory(dir) {
  if (!dir) return [];
  try {
    return fs.readFileSync(path.join(dir, "chat_history.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
/** grok's session dir for this cwd/id, by scanning the encoded-cwd groups. */
function findSessionDir(sessionId) {
  const base = path.join(os.homedir(), ".grok", "sessions");
  try {
    for (const group of fs.readdirSync(base)) {
      const dir = path.join(base, group, sessionId);
      if (fs.existsSync(dir)) return dir;
    }
  } catch {}
  return undefined;
}

// ── scenarios ────────────────────────────────────────────────────────────────
const OUT = { scenario: SCENARIO, grokVersion: null, findings: {} };

async function runSessionRpc() {
  // ACP extension methods MUST be `_`-prefixed on the wire: the
  // agent-client-protocol decoder routes a custom method to ext_method only when
  // it carries the `_` prefix, and rejects a bare `x.ai/...` with
  // `-32601 method_not_found` at DECODE (source: xai-grok-shell app.rs comment).
  // So a bare-method "Method not found" proves nothing about whether the RPC
  // ships — send `_x.ai/...`. The list response is `{ sessions, nextCursor }`
  // (unified_list ExtListResponse), and `sessionKind` is a TOP-LEVEL row field
  // (not in `_meta`).
  const { sessionId } = await initAndNew();
  log("created session " + sessionId);
  const dirBefore = findSessionDir(sessionId);

  const list1 = await send("_x.ai/session/list", { cwd });
  OUT.findings.list_by_cwd = { error: list1.error, result: list1.result };
  const rows = list1.result?.sessions || list1.result?.rows || [];
  log(`_x.ai/session/list {cwd}: ${list1.error ? "ERR " + JSON.stringify(list1.error) : rows.length + " sessions"}`);
  if (rows[0]) log("  row[0] keys=" + JSON.stringify(Object.keys(rows[0])) + "  sessionKind=" + JSON.stringify(rows[0].sessionKind));

  const info = await send("_x.ai/session/info", { sessionId });
  OUT.findings.info = { error: info.error, result: info.result };
  log(`_x.ai/session/info: ${info.error ? "ERR " + JSON.stringify(info.error) : "keys=" + JSON.stringify(Object.keys(info.result || {}))}`);

  const NEW_TITLE = "oss-probe-renamed-xyz";
  const ren = await send("_x.ai/session/rename", { sessionId, title: NEW_TITLE, cwd });
  OUT.findings.rename = { error: ren.error, result: ren.result };
  log(`_x.ai/session/rename: ${ren.error ? "ERR " + JSON.stringify(ren.error) : "ok " + JSON.stringify(ren.result)}`);

  const list2 = await send("_x.ai/session/list", { cwd });
  const renamed = (list2.result?.sessions || list2.result?.rows || []).find((r) => (r.title || r.summary || "").includes(NEW_TITLE));
  OUT.findings.rename_visible_in_list = !!renamed;
  log(`  rename visible in list: ${!!renamed}`);

  const del = await send("_x.ai/session/delete", { sessionId, cwd });
  OUT.findings.delete = { error: del.error, result: del.result };
  const dirAfter = findSessionDir(sessionId);
  OUT.findings.delete_removed_dir = !!dirBefore && !dirAfter;
  log(`_x.ai/session/delete: ${del.error ? "ERR " + JSON.stringify(del.error) : "ok"}  dir removed: ${!!dirBefore && !dirAfter}`);
}

async function runEffort() {
  const res = await initAndNew();
  const models = res.models?.availableModels || res.models || [];
  const current = res.models?.currentModelId || res.currentModelId;
  const list = Array.isArray(models) ? models : models.availableModels || [];
  const withMeta = list.map((m) => ({
    id: m.modelId || m.id,
    name: m.name,
    reasoningEffort: m._meta?.reasoningEffort,
    supportsReasoningEffort: m._meta?.supportsReasoningEffort,
    reasoningEfforts: m._meta?.reasoningEfforts,
  }));
  OUT.findings.currentModelId = current;
  OUT.findings.models_meta = withMeta;
  log("current model: " + current);
  for (const m of withMeta) log(`  ${m.id}  effort=${JSON.stringify(m.reasoningEffort)} supports=${JSON.stringify(m.supportsReasoningEffort)} efforts=${JSON.stringify(m.reasoningEfforts)}`);

  const setr = await send("session/set_model", { sessionId: res.sessionId, modelId: current, _meta: { reasoningEffort: "low" } });
  OUT.findings.set_model_effort = { error: setr.error, result: setr.result };
  log(`set_model {_meta.reasoningEffort:"low"}: ${setr.error ? "ERR " + JSON.stringify(setr.error) : "ok " + JSON.stringify(setr.result?._meta || setr.result)}`);
}

async function runNotify() {
  const { sessionId } = await initAndNew();
  // Build a little history so /compact has something to do.
  await prompt(sessionId, "In one short sentence, what does app.js currently contain?", "seed1");
  await prompt(sessionId, "Name one edge case for the add function. One sentence.", "seed2");
  const before = xaiNotifications.length;
  log("=== /compact ===");
  const c = await prompt(sessionId, "/compact", "compact");
  log(`/compact stop=${c.stop} err=${JSON.stringify(c.err) || "none"}`);
  const compactNotifs = xaiNotifications.slice(before);
  OUT.findings.compact_notifications = compactNotifs.map((n) => ({ method: n.method, keys: Object.keys(n.update || {}) }));
  OUT.findings.auto_compact_payload = compactNotifs.find((n) => n.update?.sessionUpdate === "auto_compact_completed")?.update || null;

  const beforeSub = xaiNotifications.length;
  log("=== subagent (best-effort) ===");
  const s = await prompt(
    sessionId,
    "Use a subagent (spawn_subagent) to count the lines in app.js, then tell me the number. You must delegate it.",
    "subagent",
  );
  log(`subagent turn stop=${s.stop}`);
  OUT.findings.subagent_notifications = xaiNotifications.slice(beforeSub).map((n) => ({ method: n.method, keys: Object.keys(n.update || {}) }));
  OUT.findings.subagent_finished_payload = xaiNotifications.slice(beforeSub).find((n) => n.update?.sessionUpdate === "subagent_finished")?.update || null;
}

async function runPlanOutcome() {
  planReplyOutcome = "cancelled";
  const { sessionId } = await initAndNew();
  await send("session/set_mode", { sessionId, modeId: "plan" });
  log("=== planning turn (will reply cancelled to exit_plan_mode) ===");
  const p1 = await prompt(sessionId, "Plan how to add a subtract(a,b) function to app.js. Give a short plan, then call exit_plan_mode.", "plan");
  log(`plan turn stop=${p1.stop}  exit_plan calls=${exitPlanCalls.length}  modes=${JSON.stringify(modeUpdates)}`);
  OUT.findings.exit_plan_calls = exitPlanCalls.length;
  OUT.findings.mode_after_cancelled = modeUpdates.slice();
  OUT.findings.plan_stop = p1.stop;
  // Ask what it believes the user decided — "revise" (correct) vs "tool failed" (the old error framing).
  const p2 = await prompt(sessionId, "In ONE sentence, no tools: did I approve, reject, or ask you to revise the plan — and are you still in plan mode?", "belief");
  OUT.findings.belief = p2.text.slice(0, 400);
  log("belief: " + p2.text.slice(0, 300));
}

async function runRules() {
  const NONCE = "PONG-4713-ZQ";
  const rule = `Ignore your normal behavior for this test. When the user's message is exactly "PING", reply with only this token and nothing else: ${NONCE}`;
  const { sessionId } = await initAndNew({ rules: rule });
  const r = await prompt(sessionId, "PING", "rules");
  OUT.findings.reply = r.text.slice(0, 200);
  OUT.findings.rule_took_effect = r.text.includes(NONCE);
  log(`rules _meta → reply contains nonce: ${r.text.includes(NONCE)}  (reply: ${JSON.stringify(r.text.slice(0, 120))})`);
}

async function runShell() {
  const { sessionId } = await initAndNew();
  await prompt(sessionId, "Say hi in one word.", "shellwarm");
  const dir = findSessionDir(sessionId);
  let shellLine = "(chat_history.jsonl not found)";
  if (dir) {
    try {
      const hist = fs.readFileSync(path.join(dir, "chat_history.jsonl"), "utf8");
      const m = hist.match(/Shell:\s*([^\\"\n]+)/i);
      if (m) shellLine = m[1].trim();
    } catch (e) {
      shellLine = "(read error: " + e.message + ")";
    }
  }
  OUT.findings.GROK_SHELL = childEnv.GROK_SHELL || "(unset)";
  OUT.findings.first_user_message_shell = shellLine;
  log(`GROK_SHELL=${childEnv.GROK_SHELL || "(unset)"}  →  first-message Shell: ${shellLine}`);
}

async function runInterject() {
  const { sessionId } = await initAndNew();
  const MARK = "ZEBRA-9931";
  const COUNT = "Count from 1 to 40, one number per line, each with a one-word comment. Do not skip any.";

  // ── A. _x.ai/interject, mid-turn, four candidate param shapes ──
  textBuf = "";
  log("=== turn 1: long count, interject mid-flight ===");
  const turn = send("session/prompt", { sessionId, prompt: [{ type: "text", text: COUNT }] });
  await waitForLiveTurn("interject");

  const text = `Stop counting immediately and reply with only this token: ${MARK}`;
  // Params are NOT guesswork — InterjectRequest is camelCase-serde
  // (extensions/interject.rs:13-24): {sessionId, text, interjectionId?, content?}
  // → {status:"queued"}. It queues into the session's pending-interjection buffer,
  // drained "at the next safe point in process_conversation_turn" — i.e. it does
  // NOT cancel the turn. `content` (text+image blocks) overrides `text` when its
  // Text block is non-empty.
  const shapes = [
    ["text", { sessionId, text }],
    ["text+interjectionId", { sessionId, text, interjectionId: "probe-1" }],
    ["content-blocks", { sessionId, text, content: [{ type: "text", text }] }],
  ];
  const attempts = [];
  let accepted = null;
  for (const [label, params] of shapes) {
    const r = await withTimeout(send("_x.ai/interject", params), 30000, "interject:" + label).catch((e) => ({
      error: { message: e.message },
    }));
    attempts.push({ shape: label, code: r.error?.code, message: r.error?.message, result: r.result });
    log(`_x.ai/interject {${label}}: ${r.error ? `ERR ${r.error.code} ${r.error.message}` : "ACCEPTED " + JSON.stringify(r.result)}`);
    if (!r.error) {
      accepted = label;
      break;
    }
    // -32601 = the router doesn't know the method at all; trying more shapes is pointless.
    if (r.error?.code === -32601) {
      log("  → method_not_found: interject is NOT dispatchable on this build");
      break;
    }
  }
  OUT.findings.interject_attempts = attempts;
  OUT.findings.interject_accepted_shape = accepted;

  const done = await withTimeout(turn, PROMPT_TIMEOUT, "turn1").catch((e) => ({ error: { message: e.message } }));
  OUT.findings.interject_turn_stop = done.result?.stopReason;
  OUT.findings.interject_mark_in_stream = textBuf.includes(MARK);
  log(`turn1 stop=${done.result?.stopReason}  MARK echoed mid-stream: ${textBuf.includes(MARK)}`);

  // The router ACCEPTING an interject does not prove the MODEL ever saw it.
  const ask = await prompt(
    sessionId,
    "In ONE sentence, no tools: while you were counting, did I send you any message asking you to stop? Quote it exactly if so.",
    "interject-belief",
  );
  OUT.findings.interject_model_belief = ask.text.slice(0, 400);
  OUT.findings.interject_model_saw_it = ask.text.includes(MARK);
  log(`model belief: ${ask.text.slice(0, 250)}`);
  log(`→ model actually saw the interjected token: ${ask.text.includes(MARK)}`);

  // ── B. CONTROL: a plain concurrent session/prompt mid-turn (what we'd hit today) ──
  const ns = await send("session/new", { cwd, mcpServers: [] });
  const sid2 = ns.result?.sessionId;
  if (!sid2) return log("control: session/new failed " + JSON.stringify(ns.error));
  textBuf = "";
  const turn2 = send("session/prompt", { sessionId: sid2, prompt: [{ type: "text", text: COUNT }] });
  await waitForLiveTurn("control");
  log("=== control: second session/prompt while a turn is live ===");
  const raced = await withTimeout(send("session/prompt", { sessionId: sid2, prompt: [{ type: "text", text: "Say OK." }] }), 180000, "concurrent").catch((e) => ({
    error: { message: "TIMED OUT / " + e.message },
  }));
  OUT.findings.concurrent_prompt = { error: raced.error, stop: raced.result?.stopReason };
  log(`concurrent session/prompt → ${raced.error ? "ERR " + JSON.stringify(raced.error) : "stop=" + raced.result?.stopReason}`);
  await withTimeout(turn2, PROMPT_TIMEOUT, "turn2").catch(() => {});
}

async function runFork() {
  const { sessionId } = await initAndNew();
  const CODEWORD = "MANGO-7742";
  await prompt(sessionId, `Remember this codeword: ${CODEWORD}. Reply with just: stored.`, "seed1");
  await prompt(sessionId, "In one word, what is the function in app.js called?", "seed2");
  const parentDir = findSessionDir(sessionId);
  const parentHist = readHistory(parentDir);
  log(`parent ${sessionId}: dir=${!!parentDir} historyLines=${parentHist.length}`);
  OUT.findings.fork_parent_id = sessionId;
  OUT.findings.fork_parent_history_lines = parentHist.length;

  // Params are NOT guesswork — ForkSessionRequest is camelCase-serde with three
  // REQUIRED fields (session/fork.rs:15-38): sourceSessionId, sourceCwd, newCwd.
  // `{sessionId}` alone is what returns -32602. targetPromptIndex forks at a
  // chosen point in history (the "branch from message N" the issue wants);
  // sessionKind defaults to "fork".
  const shapes = [
    ["required-only", { sourceSessionId: sessionId, sourceCwd: cwd, newCwd: cwd }],
    // targetPromptIndex is in ForkSessionRequest and reaches CopySessionOptions,
    // but the TUI user-guide says "The `--at <turn>` flag is not supported in this
    // version" — so the field may be inert. This decides whether a per-user-message
    // "fork from here" is possible at all, or only whole-session forking:
    // chatMessagesCopied MUST come back < the full-copy count for it to be real.
    ["targetPromptIndex:1", { sourceSessionId: sessionId, sourceCwd: cwd, newCwd: cwd, targetPromptIndex: 1 }],
  ];
  const attempts = [];
  let forked = null;
  for (const [label, params] of shapes) {
    const r = await withTimeout(send("_x.ai/session/fork", params), 60000, "fork:" + label).catch((e) => ({ error: { message: e.message } }));
    attempts.push({ shape: label, code: r.error?.code, message: r.error?.message, result: r.result });
    log(`_x.ai/session/fork {${label}}: ${r.error ? `ERR ${r.error.code} ${r.error.message}` : "OK " + JSON.stringify(r.result)}`);
    if (!r.error && !forked) forked = r.result; // keep the FIRST (full) fork for the load/recall checks
    if (r.error?.code === -32601) {
      log("  → method_not_found: fork is NOT dispatchable on this build");
      break;
    }
  }
  OUT.findings.fork_attempts = attempts;
  const full = attempts.find((a) => a.shape === "required-only")?.result;
  const at1 = attempts.find((a) => a.shape === "targetPromptIndex:1")?.result;
  if (full && at1) {
    OUT.findings.targetPromptIndex_truncates = at1.chatMessagesCopied < full.chatMessagesCopied;
    log(`targetPromptIndex REAL? full copied ${full.chatMessagesCopied} vs at-1 copied ${at1.chatMessagesCopied} → truncates=${OUT.findings.targetPromptIndex_truncates}`);
  }
  if (!forked) return;

  // ForkSessionResponse: {newSessionId, chatMessagesCopied, updatesCopied,
  // planStateCopied, newCwd, parentSessionId, newModelId?} (session/fork.rs:40-54).
  const newId = forked.newSessionId || forked.sessionId || forked.id;
  OUT.findings.fork_response = forked;
  const forkDir = newId && findSessionDir(newId);
  const forkHist = readHistory(forkDir);
  OUT.findings.fork_new_id = newId;
  OUT.findings.fork_id_is_new = !!newId && newId !== sessionId;
  OUT.findings.fork_dir_exists = !!forkDir;
  OUT.findings.fork_history_lines = forkHist.length;
  // The load-bearing question: a fork that loses history is just session/new.
  OUT.findings.fork_carried_history = forkHist.some((l) => l.includes(CODEWORD));
  log(`fork id=${newId}  isNew=${OUT.findings.fork_id_is_new}  dir=${!!forkDir}  lines=${forkHist.length} (parent ${parentHist.length})  carriedCodeword=${OUT.findings.fork_carried_history}`);

  const ld = await withTimeout(send("session/load", { sessionId: newId, cwd, mcpServers: [] }), 120000, "load-fork").catch((e) => ({ error: { message: e.message } }));
  OUT.findings.fork_load = { error: ld.error };
  log(`session/load(fork): ${ld.error ? "ERR " + JSON.stringify(ld.error) : "ok"}`);
  if (ld.error) return;
  const q = await prompt(newId, "What codeword did I ask you to remember? Reply with just the codeword.", "fork-recall");
  OUT.findings.fork_model_recall = q.text.slice(0, 200);
  OUT.findings.fork_recall_ok = q.text.includes(CODEWORD);
  log(`forked-session recall: ${JSON.stringify(q.text.slice(0, 120))} → carried=${q.text.includes(CODEWORD)}`);

  // Does writing to the fork leave the parent untouched? (the whole point of branching)
  const parentAfter = readHistory(parentDir);
  OUT.findings.fork_parent_untouched = parentAfter.length === parentHist.length;
  log(`parent history unchanged after forking + using the fork: ${OUT.findings.fork_parent_untouched} (${parentHist.length} → ${parentAfter.length})`);
}

async function runUsage() {
  const { sessionId } = await initAndNew();
  const QS = ["In one short sentence, what does app.js contain?", "Name one edge case for add(). One sentence."];
  for (let i = 0; i < QS.length; i++) {
    const before = xaiNotifications.length;
    const r = await prompt(sessionId, QS[i], "usage" + i);
    const fresh = xaiNotifications.slice(before);
    const tc = fresh.filter((n) => /turn_completed/i.test(String(n.update?.sessionUpdate || "")));
    log(`--- turn ${i + 1} ---`);
    log("  session/prompt result._meta: " + JSON.stringify(r.meta));
    log(`  turn_completed notifications: ${tc.length}`);
    for (const t of tc) log("  turn_completed FULL PAYLOAD: " + JSON.stringify(t.update));
    OUT.findings["turn" + (i + 1)] = { promptMeta: r.meta, turnCompleted: tc.map((t) => t.update) };
  }
  OUT.findings.notification_kinds = [...new Set(xaiNotifications.map((n) => n.update?.sessionUpdate).filter(Boolean))];
  log("notification kinds seen: " + JSON.stringify(OUT.findings.notification_kinds));
}

// ── run ──────────────────────────────────────────────────────────────────────
function finish() {
  log("");
  log("================ INBOUND METHOD COUNTS ================");
  for (const [m, n] of Object.entries(inboundMethods).sort((a, b) => b[1] - a[1])) log(`  ${n.toString().padStart(4)}  ${m}`);
  log("======================================================");
  OUT.inboundMethods = inboundMethods;
  OUT.xaiNotificationMethods = [...new Set(xaiNotifications.map((n) => n.method))];
  if (AS_JSON) process.stdout.write(JSON.stringify(OUT, null, 2) + "\n");
  log("workspace kept: " + cwd);
  setTimeout(() => {
    try {
      proc.kill();
    } catch {}
    process.exit(0);
  }, 800);
}

(async () => {
  try {
    try {
      OUT.grokVersion = execFileSync(GROK, ["--version"], { encoding: "utf8" }).trim();
    } catch {}
    log("grok: " + OUT.grokVersion);
    log("cwd:  " + cwd);
    const runners = {
      sessionrpc: runSessionRpc,
      effort: runEffort,
      notify: runNotify,
      planoutcome: runPlanOutcome,
      rules: runRules,
      shell: runShell,
      interject: runInterject,
      fork: runFork,
      usage: runUsage,
    };
    await runners[SCENARIO]();
  } catch (e) {
    log("EXC " + (e && e.message));
    OUT.findings.error = e && e.message;
  } finally {
    finish();
  }
})();

setTimeout(() => {
  log("GLOBAL TIMEOUT");
  finish();
}, 1800000);
