// Edit-diff TIMING wire probe for `grok agent stdio` (follow-up to #45).
//
// #45 paints an edit's `+N −M` + inline diff, but the GROUP-HEADER roll-up is only
// computed in closeToolGroup() — i.e. at batch close. This probe answers whether the
// underlying data is actually available earlier, and how much earlier.
//
// Q1: For a MULTI-EDIT turn, does each edit's `content[].type==="diff"` arrive on its
//     own completed tool_call_update AS IT FINISHES — measurably before the batch/turn
//     ends? (every event is timestamped, ms since prompt send)
// Q2: Does the INITIAL live `tool_call` carry rawInput.old_string/new_string? If yes we
//     could paint before the update; if no, the update is the earliest correct moment.
//     (rawInput is dumped VERBATIM, not just its keys)
// Q3: For a whole-file WRITE that OVERWRITES an existing file, what does the
//     authoritative `content` diff contain — a real old->new diff, or pure adds with
//     oldText:""? (decides whether a rawInput-derived `oldText:""` would mis-render)
//
// Run: node research/edit-diff-timing-probe.cjs        (needs a logged-in grok; burns credits)
//      node research/edit-diff-timing-probe.cjs --yolo (auto-approve; skips permission cards)
// Writes research/edit-diff-timing.log (human summary + FULL verbatim event JSON).
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const YOLO = process.argv.includes("--yolo");
function log(s) { process.stderr.write("[timing] " + s + "\n"); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-edittiming-"));
// Scenario A seeds: three files, each with one distinctive word to swap. Separate
// files (not one file x3) so the batch holds three DIFFERENT edit tool calls.
const A_FILES = ["alpha.txt", "bravo.txt", "charlie.txt"];
A_FILES.forEach((f, i) => {
  fs.writeFileSync(path.join(cwd, f),
    `line one of ${f}\nthe magic word is WIDGET${i + 1} here\nlast line stays\n`);
});
// Scenario B seed: an EXISTING file with real content, to be overwritten wholesale.
const B_FILE = "config.json";
fs.writeFileSync(path.join(cwd, B_FILE),
  '{\n  "name": "old-name",\n  "version": "1.0.0",\n  "debug": false\n}\n');

log("grok: " + GROK);
log("cwd:  " + cwd + "   mode: " + (YOLO ? "AUTO-APPROVE (yolo)" : "AGENT (permission)"));

const proc = spawn(GROK, ["agent", "--reasoning-effort", "low", "stdio"], { cwd, env: process.env });
let nextId = 1;
const waiters = new Map();
function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
proc.stderr.on("data", (d) => process.stderr.write("[grok-stderr] " + d.toString()));
proc.on("exit", (code) => log("grok exited: " + code));

// --- timing spine -----------------------------------------------------------
// t0 is stamped at each session/prompt send; every captured event records ms since
// that t0, so "how long before the turn ended did this diff land?" is measurable.
let t0 = 0;
let scenario = "";
const events = []; // { scenario, t, src, ...verbatim }
function now() { return t0 ? Date.now() - t0 : 0; }
function record(src, data) {
  events.push({ scenario, t: now(), src, data });
}

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Server -> client REQUESTS
  if (msg.method && msg.id != null) {
    const m = msg.method;
    if (m === "fs/read_text_file") {
      let content = ""; try { content = fs.readFileSync(msg.params.path, "utf8"); } catch {}
      respond(msg.id, { content });
    } else if (m === "fs/write_text_file") {
      // Stamp when the file actually hits disk — the "chat is behind the disk" baseline.
      record("fs/write_text_file", { path: msg.params?.path, bytes: (msg.params?.content || "").length });
      try { fs.writeFileSync(msg.params.path, msg.params.content); } catch {}
      respond(msg.id, {});
    } else if (m === "session/request_permission") {
      record("request_permission", { toolCall: msg.params?.toolCall });
      const opts = msg.params?.options || [];
      const allow = opts.find((o) => o.kind === "allow_once") || opts.find((o) => o.kind === "allow_always") || opts[0];
      respond(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
    } else if (m === "terminal/create") respond(msg.id, { terminalId: "t1" });
    else if (m === "terminal/output") respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    else if (m === "terminal/wait_for_exit") respond(msg.id, { exitCode: 0 });
    else if (m.startsWith("terminal/")) respond(msg.id, {});
    else respond(msg.id, {});
    return;
  }

  if (msg.method === "session/update") {
    const u = msg.params && msg.params.update;
    if (!u) return;
    const kind = u.sessionUpdate;
    if (kind === "tool_call" || kind === "tool_call_update") record(kind, u);
    return;
  }

  if (msg.id != null && waiters.has(msg.id)) {
    const res = waiters.get(msg.id); waiters.delete(msg.id); res(msg);
  }
});

function hasDiff(d) {
  return Array.isArray(d?.content) && d.content.some((c) => c && c.type === "diff");
}

(async () => {
  const timer = setTimeout(() => { log("TIMEOUT (300s)"); dump(); proc.kill(); process.exit(2); }, 300_000);
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "edit-diff-timing-probe", version: "0" },
  });
  const sess = await send("session/new", { cwd, mcpServers: [] });
  if (!sess.result) { log("session/new FAILED: " + JSON.stringify(sess.error)); proc.kill(); process.exit(1); }
  const sessionId = sess.result.sessionId;
  log("session: " + sessionId);

  if (YOLO) {
    const sm = await send("session/set_mode", { sessionId, modeId: "yolo" });
    log("set_mode yolo -> " + (sm.error ? "ERR" : "ok"));
  }

  // ---- Scenario A: multi-file edit in ONE turn (Q1 + Q2) --------------------
  scenario = "A-multi-edit";
  t0 = Date.now();
  const a = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "In the current directory there are three files: alpha.txt, bravo.txt and charlie.txt. " +
      "In alpha.txt replace WIDGET1 with GADGET1. In bravo.txt replace WIDGET2 with GADGET2. " +
      "In charlie.txt replace WIDGET3 with GADGET3. Use your file-editing tool for each. " +
      "Do not run any shell commands. Do not read the files first if you can avoid it." }],
  });
  record("PROMPT_END", { stopReason: a.result && a.result.stopReason });
  log("A stopReason: " + JSON.stringify(a.result && a.result.stopReason));

  // ---- Scenario B: whole-file WRITE overwriting an existing file (Q3) -------
  scenario = "B-overwrite";
  t0 = Date.now();
  const b = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "Now completely overwrite the existing file config.json with exactly this content, " +
      'using your whole-file write tool (not a search/replace):\n' +
      '{\n  "name": "new-name",\n  "version": "2.0.0",\n  "debug": true,\n  "added": "field"\n}\n' +
      "Do not run any shell commands." }],
  });
  record("PROMPT_END", { stopReason: b.result && b.result.stopReason });
  log("B stopReason: " + JSON.stringify(b.result && b.result.stopReason));

  clearTimeout(timer);
  dump();
  proc.kill();
  process.exit(0);
})().catch((e) => { log("probe error: " + (e.stack || e.message)); dump(); proc.kill(); process.exit(1); });

function dump() {
  const out = [];
  const scenarios = [...new Set(events.map((e) => e.scenario))];
  out.push("========== EDIT DIFF TIMING ==========");
  out.push("mode: " + (YOLO ? "AUTO-APPROVE (yolo)" : "AGENT (permission)"));
  out.push("grok: " + GROK);
  out.push("");

  for (const s of scenarios) {
    const evs = events.filter((e) => e.scenario === s);
    const end = evs.find((e) => e.src === "PROMPT_END");
    out.push("===== scenario " + s + " =====");
    out.push("turn ended at t=" + (end ? end.t : "?") + "ms  stopReason=" + JSON.stringify(end?.data?.stopReason));
    out.push("");
    out.push("--- timeline (t = ms since prompt send) ---");
    for (const e of evs) {
      const d = e.data || {};
      if (e.src === "PROMPT_END") { out.push(`  t=${String(e.t).padStart(6)}  << TURN END >>`); continue; }
      if (e.src === "fs/write_text_file") {
        out.push(`  t=${String(e.t).padStart(6)}  [fs/write_text_file] ${path.basename(d.path || "?")} (${d.bytes}b)  <- file hits disk`);
        continue;
      }
      const diffMark = hasDiff(d) ? "  ***HAS type:'diff'***" : "";
      const lag = end ? `  (lead over turn end: ${end.t - e.t}ms)` : "";
      out.push(`  t=${String(e.t).padStart(6)}  [${e.src}] id=${d.toolCallId ?? "?"} kind=${JSON.stringify(d.kind)} status=${JSON.stringify(d.status)} title=${JSON.stringify(d.title)}${diffMark}${hasDiff(d) ? lag : ""}`);
      if (d.rawInput !== undefined) {
        out.push(`             rawInput VERBATIM: ${JSON.stringify(d.rawInput)}`);
      }
      if (d.content !== undefined) {
        out.push(`             content VERBATIM:  ${JSON.stringify(d.content)}`);
      }
    }
    out.push("");

    // Q1 answer: per-edit diff lead time over turn end.
    const diffEvs = evs.filter((e) => hasDiff(e.data));
    out.push("--- Q1: diff arrival vs turn end ---");
    if (!diffEvs.length) out.push("  (no diff-carrying events)");
    for (const e of diffEvs) {
      const p = (e.data.content.find((c) => c.type === "diff") || {}).path;
      out.push(`  ${path.basename(p || "?")}: diff landed t=${e.t}ms on [${e.src}], ` +
               `turn ended t=${end ? end.t : "?"}ms -> lead ${end ? end.t - e.t : "?"}ms`);
    }
    out.push("");

    // Q2 answer: did the INITIAL tool_call carry the edit args?
    out.push("--- Q2: does the initial tool_call carry rawInput.old_string/new_string? ---");
    const initial = evs.filter((e) => e.src === "tool_call");
    if (!initial.length) out.push("  (no tool_call events)");
    for (const e of initial) {
      const r = e.data.rawInput;
      const keys = r && typeof r === "object" ? Object.keys(r) : [];
      const hasArgs = !!(r && (r.old_string != null || r.new_string != null || r.oldText != null || r.newText != null));
      out.push(`  [tool_call] id=${e.data.toolCallId} title=${JSON.stringify(e.data.title)}`);
      out.push(`      rawInput present=${r !== undefined} keys=${JSON.stringify(keys)} hasEditArgs=${hasArgs}`);
      out.push(`      content present=${e.data.content !== undefined} hasDiff=${hasDiff(e.data)}`);
    }
    out.push("");
  }

  // Q3 answer: the overwrite's authoritative diff shape.
  out.push("--- Q3: whole-file overwrite — authoritative content diff shape ---");
  const bDiffs = events.filter((e) => e.scenario === "B-overwrite" && hasDiff(e.data));
  if (!bDiffs.length) out.push("  (no diff-carrying event in scenario B)");
  for (const e of bDiffs) {
    for (const c of e.data.content.filter((x) => x.type === "diff")) {
      out.push(`  [${e.src}] path=${JSON.stringify(c.path)}`);
      out.push(`      oldText === ""  ? ${c.oldText === ""}   (len ${(c.oldText ?? "").length})`);
      out.push(`      oldText VERBATIM: ${JSON.stringify(c.oldText)}`);
      out.push(`      newText VERBATIM: ${JSON.stringify(c.newText)}`);
      out.push(`      => ${c.oldText === "" ? "PURE ADDS (oldText empty)" : "REAL old->new DIFF (oldText carries prior content)"}`);
    }
  }
  out.push("");
  out.push("final config.json on disk: " + JSON.stringify(fs.readFileSync(path.join(cwd, B_FILE), "utf8")));
  A_FILES.forEach((f) => out.push(`final ${f}: ` + JSON.stringify(fs.readFileSync(path.join(cwd, f), "utf8"))));

  const text = out.join("\n");
  process.stderr.write("\n" + text + "\n");
  try {
    const p = path.join(__dirname, "edit-diff-timing.log");
    fs.writeFileSync(p, text + "\n\n===== FULL VERBATIM EVENTS JSON =====\n" + JSON.stringify(events, null, 2));
    log("wrote " + p);
  } catch (e) { log("write log failed: " + e.message); }
}
