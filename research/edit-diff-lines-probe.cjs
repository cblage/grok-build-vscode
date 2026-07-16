// Edit-diff LINE-NUMBER / replace-all wire probe for `grok agent stdio` (follow-up to #45).
//
// `research/edit-diff-timing-probe.cjs` established that an edit's diff rides the
// tool_call_update as {type:"diff", path, oldText, newText, _meta:{old_line,new_line}}, and
// that the COMPLETED update additionally carries _meta.details[]. But every capture there is a
// SINGLE-occurrence, single-line replace at line 2 of a 3-line file — which can't distinguish
// "1-based real file line" from "region-relative index", and says nothing about replace_all.
// This probe closes those gaps.
//
// Q1: For a REPLACE-ALL over N known occurrences, does the completed update's _meta.details[]
//     enumerate EVERY replaced site (details.length === N), or just one? This decides whether a
//     client rendering `+1 −1` for a 148-occurrence replace has a CLIENT gap or hit a CLI defect.
//     Fixture: 12 PLACEHOLDER occurrences on KNOWN, non-consecutive lines (3,5,…,25) so a
//     reported old_line can be checked against ground truth.
// Q2: Are old_line/new_line 1-based REAL FILE lines, and for a MULTI-LINE region is old_line the
//     region's FIRST line? Fixture: a 3-line block at lines 40-42 of a 60-line file — 40 proves
//     1-based-real-file + first-line; 1 would prove region-relative; 42 would prove last-line.
// Q3: Does the pre-write ECHO carry the same _meta as the COMPLETED update (i.e. is old_line
//     available at the earliest paintable moment, or only once the write lands)?
// Q4: For a whole-file WRITE (overwrite + fresh create), what are old_line/new_line, and does
//     _meta.details[] appear at all?
// Q5: In a replace-all whose replacement CHANGES the line count, does a later site's new_line
//     account for the cumulative shift from earlier sites (old_line=2,4,6 -> new_line=2,6,10 for
//     a +2-lines-each replacement), or does it just mirror old_line? This decides whether a
//     client can trust new_line as a post-edit gutter number or must accumulate the offset
//     itself. Every site in scenarios A/B is line-count-neutral, so they can't answer it.
//
// Run: node research/edit-diff-lines-probe.cjs          (needs a logged-in grok; burns credits)
//      node research/edit-diff-lines-probe.cjs --agent  (permission mode; default is auto-approve)
// Writes research/edit-diff-lines.log (verdicts + FULL verbatim event JSON).
//
// Safety: grok runs against a throwaway mkdtemp workspace. Any fs/write_text_file resolving
// inside this repo is REFUSED (logged, error returned, nothing written); terminals are ACKed
// but never executed.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const YOLO = !process.argv.includes("--agent");
const REPO_ROOT = path.resolve(__dirname, "..");
function log(s) { process.stderr.write("[lines] " + s + "\n"); }

// --- containment guard: nothing the agent asks for may land in this repo -----
function insideRepo(p) {
  try {
    const rel = path.relative(REPO_ROOT, path.resolve(p));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch { return true; } // unparseable path -> treat as unsafe
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-editlines-"));

// ---- Scenario A seed: 12 PLACEHOLDER occurrences on KNOWN lines -------------
// Interleaved with filler so the occurrence lines are NON-CONSECUTIVE (3,5,7,…,25):
// a details[] that merely counts 1..12 would be indistinguishable from real line
// numbers on a consecutive fixture, so the gaps are load-bearing.
const A_FILE = "placeholders.txt";
const A_LINES = [];
const A_EXPECTED_LINES = [];
A_LINES.push("header of placeholders.txt");
A_LINES.push("intro filler line");
for (let i = 1; i <= 12; i++) {
  A_LINES.push(`item ${i}: the token is PLACEHOLDER here`);
  A_EXPECTED_LINES.push(A_LINES.length); // 1-based line of the just-pushed line
  A_LINES.push(`  filler after item ${i}`);
}
A_LINES.push("tail of file");
const A_OCCURRENCES = A_EXPECTED_LINES.length; // 12
fs.writeFileSync(path.join(cwd, A_FILE), A_LINES.join("\n") + "\n");

// ---- Scenario B seed: a 3-line block at lines 40-42 of a 60-line file -------
const B_FILE = "deepfile.txt";
const B_LINES = [];
for (let i = 1; i <= 60; i++) {
  if (i === 40) B_LINES.push("BLOCK_START marker line");
  else if (i === 41) B_LINES.push("middle of the block to replace");
  else if (i === 42) B_LINES.push("BLOCK_END marker line");
  else B_LINES.push(`filler line number ${i}`);
}
const B_REGION_FIRST_LINE = 40;
const B_REGION_LAST_LINE = 42;
fs.writeFileSync(path.join(cwd, B_FILE), B_LINES.join("\n") + "\n");

// ---- Scenario C seed: an existing file to be overwritten wholesale ----------
const C_FILE = "settings.json";
fs.writeFileSync(path.join(cwd, C_FILE),
  '{\n  "theme": "old-theme",\n  "size": 12,\n  "beta": false\n}\n');

// ---- Scenario D: a brand-new file (no seed on purpose) ---------------------
const D_FILE = "brandnew.txt";

// ---- Scenario E seed: replace-all whose replacement GROWS the line count ----
// EXPANDME sits alone on lines 2,4,6; each is replaced by a 3-line block (+2 lines each).
// If new_line is shift-aware the sites report 2,6,10; if it mirrors old_line, 2,4,6.
const E_FILE = "expand.txt";
const E_LINES = [];
const E_EXPECTED_OLD = [];
E_LINES.push("header of expand.txt");
for (let i = 1; i <= 3; i++) {
  E_LINES.push("EXPANDME");
  E_EXPECTED_OLD.push(E_LINES.length);
  E_LINES.push(`filler ${i}`);
}
E_LINES.push("tail of expand.txt");
// Each EXPANDME -> 3 lines: +2 per site, so a shift-aware new_line runs 2,6,10.
const E_EXPECTED_NEW_SHIFTED = E_EXPECTED_OLD.map((l, i) => l + i * 2);
fs.writeFileSync(path.join(cwd, E_FILE), E_LINES.join("\n") + "\n");

log("grok: " + GROK);
log("cwd:  " + cwd + "   mode: " + (YOLO ? "AUTO-APPROVE (yolo)" : "AGENT (permission)"));
log(`A: ${A_OCCURRENCES} PLACEHOLDER occurrences at lines [${A_EXPECTED_LINES.join(",")}]`);
log(`B: 3-line block at lines ${B_REGION_FIRST_LINE}-${B_REGION_LAST_LINE} of 60`);

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
function respondError(id, message) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}
proc.stderr.on("data", (d) => process.stderr.write("[grok-stderr] " + d.toString()));
proc.on("exit", (code) => log("grok exited: " + code));

let scenario = "";
const events = [];
const refusals = [];
function record(src, data) { events.push({ scenario, src, data }); }

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method && msg.id != null) {
    const m = msg.method;
    if (m === "fs/read_text_file") {
      let content = ""; try { content = fs.readFileSync(msg.params.path, "utf8"); } catch {}
      respond(msg.id, { content });
    } else if (m === "fs/write_text_file") {
      const p = msg.params && msg.params.path;
      if (insideRepo(p)) {
        refusals.push(p);
        log("REFUSED write into repo: " + p);
        record("REFUSED_WRITE", { path: p });
        respondError(msg.id, "refused: probe will not write inside the repo");
        return;
      }
      record("fs/write_text_file", { path: p, bytes: (msg.params.content || "").length });
      try { fs.writeFileSync(p, msg.params.content); } catch (e) { log("write failed: " + e.message); }
      respond(msg.id, {});
    } else if (m === "session/request_permission") {
      const opts = (msg.params && msg.params.options) || [];
      const allow = opts.find((o) => o.kind === "allow_once") || opts.find((o) => o.kind === "allow_always") || opts[0];
      respond(msg.id, { outcome: { outcome: "selected", optionId: allow && allow.optionId } });
    } else if (m === "terminal/create") respond(msg.id, { terminalId: "t1" }); // ACK only, never executed
    else if (m === "terminal/output") respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    else if (m === "terminal/wait_for_exit") respond(msg.id, { exitCode: 0 });
    else if (m.startsWith("terminal/")) respond(msg.id, {});
    else respond(msg.id, {});
    return;
  }

  if (msg.method === "session/update") {
    const u = msg.params && msg.params.update;
    if (!u) return;
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") record(u.sessionUpdate, u);
    return;
  }

  if (msg.id != null && waiters.has(msg.id)) {
    const res = waiters.get(msg.id); waiters.delete(msg.id); res(msg);
  }
});

function diffBlocks(d) {
  return Array.isArray(d && d.content) ? d.content.filter((c) => c && c.type === "diff") : [];
}
function hasDiff(d) { return diffBlocks(d).length > 0; }
// The echo is the pre-write update: kind:"edit", titled, no status. The authoritative one is
// status:"completed" with no title/kind. (Established by edit-diff-timing-probe.cjs.)
function isEcho(e) { return e.src === "tool_call_update" && e.data.status !== "completed"; }
function isCompleted(e) { return e.src === "tool_call_update" && e.data.status === "completed"; }

(async () => {
  const timer = setTimeout(() => { log("TIMEOUT (420s)"); dump(); proc.kill(); process.exit(2); }, 420_000);
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "edit-diff-lines-probe", version: "0" },
  });
  const sess = await send("session/new", { cwd, mcpServers: [] });
  if (!sess.result) { log("session/new FAILED: " + JSON.stringify(sess.error)); proc.kill(); process.exit(1); }
  const sessionId = sess.result.sessionId;
  log("session: " + sessionId);
  if (YOLO) {
    const sm = await send("session/set_mode", { sessionId, modeId: "yolo" });
    log("set_mode yolo -> " + (sm.error ? "ERR" : "ok"));
  }

  async function turn(name, text) {
    scenario = name;
    const r = await send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    record("PROMPT_END", { stopReason: r.result && r.result.stopReason });
    log(`${name} stopReason: ${JSON.stringify(r.result && r.result.stopReason)}`);
  }

  // ---- A: replace-all over 12 known occurrences (Q1) -----------------------
  await turn("A-replace-all",
    `The file ${A_FILE} contains exactly ${A_OCCURRENCES} occurrences of the token PLACEHOLDER. ` +
    "Replace EVERY occurrence of PLACEHOLDER with REPLACED, in a SINGLE edit tool call using " +
    "your edit tool's replace-all option. Do not make one call per occurrence. " +
    "Do not run any shell commands.");

  // ---- B: multi-line region deep in the file (Q2) --------------------------
  await turn("B-multiline-region",
    `The file ${B_FILE} has 60 lines. It contains this exact 3-line block:\n` +
    "BLOCK_START marker line\nmiddle of the block to replace\nBLOCK_END marker line\n" +
    "Replace those three lines, in ONE edit tool call, with these two lines:\n" +
    "REPLACED_START new line\nREPLACED_END new line\n" +
    "Do not run any shell commands. Do not change anything else.");

  // ---- C: whole-file overwrite of an existing file (Q4) --------------------
  await turn("C-overwrite",
    `Completely overwrite the existing file ${C_FILE} with exactly this content, using your ` +
    "whole-file write tool (not a search/replace):\n" +
    '{\n  "theme": "new-theme",\n  "size": 20,\n  "beta": true,\n  "extra": "added"\n}\n' +
    "Do not run any shell commands.");

  // ---- D: fresh file create (Q4 control) ----------------------------------
  await turn("D-new-file",
    `Create a NEW file ${D_FILE} using your whole-file write tool, containing exactly these ` +
    "three lines:\nfirst new line\nsecond new line\nthird new line\n" +
    "Do not run any shell commands.");

  // ---- E: replace-all whose replacement grows the line count (Q5) ----------
  await turn("E-replace-all-growing",
    `The file ${E_FILE} contains exactly 3 lines that consist solely of the token EXPANDME. ` +
    "Replace EVERY occurrence of EXPANDME with these three lines:\n" +
    "alpha inserted line\nbravo inserted line\ncharlie inserted line\n" +
    "Do this in a SINGLE edit tool call using your edit tool's replace-all option. " +
    "Do not make one call per occurrence. Do not run any shell commands.");

  // ---- F: session/load REPLAY — the third diff shape (#30) ----------------
  // Live, an edit arrives as echo + completed. On replay the whole edit collapses into a
  // single completed `tool_call` — so which _meta shape does THAT carry? A client seeding
  // gutter numbers from the block-level _meta needs to know if restore has them at all.
  scenario = "F-replay";
  const load = await send("session/load", { sessionId, cwd, mcpServers: [] });
  log("session/load -> " + (load.error ? "ERR " + JSON.stringify(load.error) : "ok"));
  await new Promise((r) => setTimeout(r, 3000)); // let the replay stream drain

  clearTimeout(timer);
  dump();
  proc.kill();
  process.exit(0);
})().catch((e) => { log("probe error: " + (e.stack || e.message)); dump(); proc.kill(); process.exit(1); });

function dump() {
  const out = [];
  out.push("========== EDIT DIFF: LINE NUMBERS + REPLACE-ALL ==========");
  out.push("grok: " + GROK + "   mode: " + (YOLO ? "AUTO-APPROVE (yolo)" : "AGENT (permission)"));
  out.push("cwd:  " + cwd);
  out.push("repo-write refusals: " + (refusals.length ? JSON.stringify(refusals) : "none"));
  out.push("");

  for (const s of [...new Set(events.map((e) => e.scenario))]) {
    const evs = events.filter((e) => e.scenario === s);
    out.push("===== scenario " + s + " =====");
    for (const e of evs) {
      const d = e.data || {};
      if (e.src === "PROMPT_END") { out.push("  << TURN END >> stopReason=" + JSON.stringify(d.stopReason)); continue; }
      if (e.src === "fs/write_text_file") { out.push(`  [fs/write_text_file] ${path.basename(d.path || "?")} (${d.bytes}b)`); continue; }
      if (e.src === "REFUSED_WRITE") { out.push(`  [REFUSED_WRITE] ${d.path}`); continue; }
      out.push(`  [${e.src}] id=${d.toolCallId ?? "?"} kind=${JSON.stringify(d.kind)} status=${JSON.stringify(d.status)} title=${JSON.stringify(d.title)}${hasDiff(d) ? "  ***HAS type:'diff'***" : ""}`);
      if (d.rawInput !== undefined) out.push(`      rawInput VERBATIM: ${JSON.stringify(d.rawInput)}`);
      if (d.content !== undefined) out.push(`      content VERBATIM:  ${JSON.stringify(d.content)}`);
    }
    out.push("");
  }

  // ---- Q1: does details[] enumerate every replaced site? -------------------
  out.push("--- Q1: replace-all — does _meta.details[] enumerate EVERY site? ---");
  out.push(`  ground truth: ${A_OCCURRENCES} occurrences at lines [${A_EXPECTED_LINES.join(",")}]`);
  const aCompleted = events.filter((e) => e.scenario === "A-replace-all" && isCompleted(e) && hasDiff(e.data));
  if (!aCompleted.length) out.push("  (no completed diff-carrying update in scenario A)");
  for (const e of aCompleted) {
    for (const c of diffBlocks(e.data)) {
      const meta = c._meta || {};
      const details = Array.isArray(meta.details) ? meta.details : null;
      out.push(`  [completed] path=${path.basename(c.path || "?")}`);
      out.push(`      block-level _meta: old_line=${meta.old_line} new_line=${meta.new_line}`);
      out.push(`      block oldText=${JSON.stringify(c.oldText)} newText=${JSON.stringify(c.newText)}`);
      out.push(`      details present=${details !== null} length=${details ? details.length : "n/a"}  (expected ${A_OCCURRENCES})`);
      if (details) {
        out.push(`      details old_line values: [${details.map((x) => x.old_line).join(",")}]`);
        out.push(`      details new_line values: [${details.map((x) => x.new_line).join(",")}]`);
        const got = details.map((x) => x.old_line).join(",");
        const want = A_EXPECTED_LINES.join(",");
        out.push(`      VERDICT: length ${details.length === A_OCCURRENCES ? "MATCHES" : "DOES NOT MATCH"} occurrence count` +
                 `; old_line set ${got === want ? "MATCHES ground truth" : "DIFFERS from ground truth (want [" + want + "])"}`);
        details.forEach((x, i) => out.push(`        details[${i}] VERBATIM: ${JSON.stringify(x)}`));
      }
    }
  }
  out.push("");

  // ---- Q2: old_line/new_line semantics ------------------------------------
  out.push("--- Q2: old_line/new_line semantics on a MULTI-LINE region ---");
  out.push(`  ground truth: region occupies lines ${B_REGION_FIRST_LINE}-${B_REGION_LAST_LINE} of a 60-line file`);
  out.push(`  => ${B_REGION_FIRST_LINE} means 1-based REAL FILE line, region FIRST line`);
  out.push(`  => 1 would mean REGION-RELATIVE; ${B_REGION_LAST_LINE} would mean region LAST line`);
  for (const e of events.filter((x) => x.scenario === "B-multiline-region" && hasDiff(x.data))) {
    for (const c of diffBlocks(e.data)) {
      const meta = c._meta || {};
      out.push(`  [${isCompleted(e) ? "completed" : "echo"}] block _meta: old_line=${meta.old_line} new_line=${meta.new_line}`);
      out.push(`      oldText VERBATIM: ${JSON.stringify(c.oldText)}`);
      out.push(`      newText VERBATIM: ${JSON.stringify(c.newText)}`);
      if (meta.old_line === B_REGION_FIRST_LINE) out.push("      VERDICT: 1-based REAL FILE line, region FIRST line");
      else if (meta.old_line === 1) out.push("      VERDICT: REGION-RELATIVE (starts at 1)");
      else if (meta.old_line === B_REGION_LAST_LINE) out.push("      VERDICT: region LAST line");
      else out.push(`      VERDICT: UNEXPECTED value ${meta.old_line}`);
      if (Array.isArray(meta.details)) meta.details.forEach((x, i) => out.push(`      details[${i}] VERBATIM: ${JSON.stringify(x)}`));
    }
  }
  out.push("");

  // ---- Q3: echo vs completed _meta ----------------------------------------
  out.push("--- Q3: does the pre-write ECHO carry the same _meta as the COMPLETED update? ---");
  for (const s of [...new Set(events.map((e) => e.scenario))]) {
    const echoes = events.filter((e) => e.scenario === s && isEcho(e) && hasDiff(e.data));
    const comps = events.filter((e) => e.scenario === s && isCompleted(e) && hasDiff(e.data));
    for (const echo of echoes) {
      const id = echo.data.toolCallId;
      const comp = comps.find((c) => c.data.toolCallId === id);
      const em = diffBlocks(echo.data)[0] && diffBlocks(echo.data)[0]._meta;
      const cm = comp && diffBlocks(comp.data)[0] && diffBlocks(comp.data)[0]._meta;
      out.push(`  [${s}] id=${id}`);
      out.push(`      echo      _meta VERBATIM: ${JSON.stringify(em)}`);
      out.push(`      completed _meta VERBATIM: ${JSON.stringify(cm)}`);
      out.push(`      echo has old_line?      ${em && em.old_line !== undefined}  (value ${em && em.old_line})`);
      out.push(`      completed has old_line? ${cm && cm.old_line !== undefined}  (value ${cm && cm.old_line})`);
      out.push(`      echo has details[]?      ${!!(em && Array.isArray(em.details))}`);
      out.push(`      completed has details[]? ${!!(cm && Array.isArray(cm.details))}`);
      out.push(`      _meta identical? ${JSON.stringify(em) === JSON.stringify(cm)}`);
    }
  }
  out.push("");

  // ---- Q4: whole-file write ------------------------------------------------
  out.push("--- Q4: whole-file WRITE — old_line/new_line + details[] presence ---");
  for (const s of ["C-overwrite", "D-new-file"]) {
    for (const e of events.filter((x) => x.scenario === s && hasDiff(x.data))) {
      for (const c of diffBlocks(e.data)) {
        const meta = c._meta || {};
        out.push(`  [${s}][${isCompleted(e) ? "completed" : "echo"}] path=${path.basename(c.path || "?")}`);
        out.push(`      _meta VERBATIM: ${JSON.stringify(meta)}`);
        out.push(`      old_line=${meta.old_line} new_line=${meta.new_line} details present=${Array.isArray(meta.details)}` +
                 (Array.isArray(meta.details) ? ` length=${meta.details.length}` : ""));
        out.push(`      oldText === "" ? ${c.oldText === ""} (len ${(c.oldText ?? "").length})`);
        out.push(`      oldText VERBATIM: ${JSON.stringify(c.oldText)}`);
        out.push(`      newText VERBATIM: ${JSON.stringify(c.newText)}`);
      }
    }
  }
  out.push("");

  // ---- Q5: is new_line shift-aware across sites? --------------------------
  out.push("--- Q5: replace-all with a GROWING replacement — is new_line shift-aware? ---");
  out.push(`  ground truth: EXPANDME at old lines [${E_EXPECTED_OLD.join(",")}], each -> 3 lines (+2 per site)`);
  out.push(`  => new_line [${E_EXPECTED_NEW_SHIFTED.join(",")}] means SHIFT-AWARE (post-edit lines)`);
  out.push(`  => new_line [${E_EXPECTED_OLD.join(",")}] means it MIRRORS old_line (pre-edit lines; client must accumulate)`);
  for (const e of events.filter((x) => x.scenario === "E-replace-all-growing" && isCompleted(x) && hasDiff(x.data))) {
    for (const c of diffBlocks(e.data)) {
      const meta = c._meta || {};
      const details = Array.isArray(meta.details) ? meta.details : null;
      out.push(`  [completed] path=${path.basename(c.path || "?")} details length=${details ? details.length : "n/a"}`);
      if (details) {
        const gotOld = details.map((x) => x.old_line);
        const gotNew = details.map((x) => x.new_line);
        out.push(`      details old_line values: [${gotOld.join(",")}]  (expected [${E_EXPECTED_OLD.join(",")}])`);
        out.push(`      details new_line values: [${gotNew.join(",")}]`);
        const shifted = gotNew.join(",") === E_EXPECTED_NEW_SHIFTED.join(",");
        const mirrors = gotNew.join(",") === gotOld.join(",");
        out.push(`      VERDICT: ${shifted ? "SHIFT-AWARE — new_line is a real post-edit line" :
          mirrors ? "MIRRORS old_line — NOT shift-aware; client must accumulate the offset" :
          "UNEXPECTED — neither shift-aware nor mirroring"}`);
        details.forEach((x, i) => out.push(`        details[${i}] VERBATIM: ${JSON.stringify(x)}`));
      }
    }
  }
  for (const e of events.filter((x) => x.scenario === "E-replace-all-growing" && isEcho(x) && hasDiff(x.data))) {
    const m = diffBlocks(e.data)[0] && diffBlocks(e.data)[0]._meta;
    out.push(`  [echo] block _meta VERBATIM: ${JSON.stringify(m)}`);
  }
  out.push("");

  // ---- F: which _meta shape does session/load replay carry? ---------------
  out.push("--- F: session/load REPLAY — which _meta shape does the replayed tool_call carry? ---");
  const fEvs = events.filter((e) => e.scenario === "F-replay" && hasDiff(e.data));
  if (!fEvs.length) out.push("  (no diff-carrying event replayed)");
  for (const e of fEvs) {
    for (const c of diffBlocks(e.data)) {
      const meta = c._meta || {};
      const details = Array.isArray(meta.details) ? meta.details : null;
      out.push(`  [${e.src}] status=${JSON.stringify(e.data.status)} path=${path.basename(c.path || "?")}`);
      out.push(`      block _meta.old_line=${meta.old_line} new_line=${meta.new_line}`);
      out.push(`      details present=${details !== null}` + (details ? ` length=${details.length} old_line=[${details.map((x) => x.old_line).join(",")}]` : ""));
      out.push(`      _meta VERBATIM: ${JSON.stringify(meta)}`);
      out.push(`      => a client seeding from BLOCK _meta gets ${meta.old_line !== undefined ? "a real line (" + meta.old_line + ")" : "NOTHING (falls back to 1)"}` +
               `; from details[0] it gets ${details && details[0] ? details[0].old_line : "NOTHING"}`);
    }
  }
  out.push("");

  out.push("--- final files on disk ---");
  for (const f of [A_FILE, B_FILE, C_FILE, D_FILE, E_FILE]) {
    let v; try { v = fs.readFileSync(path.join(cwd, f), "utf8"); } catch (e) { v = "<missing: " + e.code + ">"; }
    out.push(`  ${f}: ${JSON.stringify(v)}`);
  }
  // Ground-truth cross-check: how many PLACEHOLDER actually survived?
  try {
    const after = fs.readFileSync(path.join(cwd, A_FILE), "utf8");
    const left = (after.match(/PLACEHOLDER/g) || []).length;
    const done = (after.match(/REPLACED/g) || []).length;
    out.push(`  ${A_FILE} ground truth after edit: PLACEHOLDER left=${left}, REPLACED=${done} (expected 0 / ${A_OCCURRENCES})`);
  } catch {}

  const text = out.join("\n");
  process.stderr.write("\n" + text + "\n");
  try {
    const p = path.join(__dirname, "edit-diff-lines.log");
    fs.writeFileSync(p, text + "\n\n===== FULL VERBATIM EVENTS JSON =====\n" + JSON.stringify(events, null, 2));
    log("wrote " + p);
  } catch (e) { log("write log failed: " + e.message); }
}
