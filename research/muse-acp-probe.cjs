#!/usr/bin/env node
// Build first: npm run compile
// node research/muse-acp-probe.cjs /absolute/path/to/muse /absolute/workspace
// Or set MUSE_CODE_EXECUTABLE and MUSE_PROBE_WORKSPACE. No TTY is needed.
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { AcpClient } = require("../out/acp.js");
const { MuseBackend } = require("../out/muse-backend.js");
const { locateMuseCli } = require("../out/muse-cli-locator.js");

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  if (process.platform === "win32") throw new Error("Run this probe on macOS or Linux; Muse has no native Windows binary.");
  const workspace = process.argv[3] || process.env.MUSE_PROBE_WORKSPACE;
  if (!workspace) throw new Error("Supply a workspace as argv[3] or MUSE_PROBE_WORKSPACE.");
  const cliPath = locateMuseCli({ configuredPath: process.argv[2] || process.env.MUSE_CODE_EXECUTABLE });
  if (!cliPath) throw new Error("No executable Muse CLI found. Supply its path as argv[2] or MUSE_CODE_EXECUTABLE.");
  let diagnostics = "", answer = "";
  const client = new AcpClient({ cliPath, cwd: path.resolve(workspace), backend: new MuseBackend(),
    log: message => process.stderr.write(`${message}\n`),
    timeouts: { requestTimeoutMs: 30_000, promptIdleTimeoutMs: 120_000, promptAbsoluteTimeoutMs: 180_000 } });
  const exit = new Promise(resolve => client.once("exit", code => {
    console.log(`OBSERVED adapter exit: ${JSON.stringify({ code })}`);
    resolve(code);
  }));
  client.on("error", error => process.stderr.write(`ACP error: ${error.message}\n`));
  client.on("stderr", chunk => { diagnostics += chunk; });
  client.on("messageChunk", text => { answer += text; });
  client.on("permissionRequest", request => {
    // Arithmetic and memory need no tools. Keep unexpected approvals noninteractive.
    const deny = request.options.find(option => option.kind === "reject_once");
    console.log(`OBSERVED unexpected permission: ${request.toolCall.title}; denying`);
    if (deny) client.respondPermission(request.id, deny.optionId);
    else void client.cancel().catch(error => process.stderr.write(`${error}\n`));
  });
  let failure;
  try {
    await client.start();
    const session = await client.newSession();
    assert.ok(session.sessionId);
    console.log(`OBSERVED new session: ${session.sessionId}`);
    console.log(`OBSERVED models: ${JSON.stringify(client.availableModels)}`);
    const token = randomBytes(10).toString("hex");
    const first = await client.prompt(`Remember this token for my next message: ${token}. Without using any tools, calculate 19 + 23. Reply with only the number.`);
    console.log(`OBSERVED first answer: ${JSON.stringify(answer)}; result=${JSON.stringify(first)}`);
    assert.equal(answer.trim(), "42", "first answer must be correct");
    answer = "";
    const second = await client.prompt("Without using any tools, reply with only the exact token I asked you to remember in my previous message.");
    console.log(`OBSERVED second answer in ${client.sessionId}: ${JSON.stringify(answer)}; result=${JSON.stringify(second)}`);
    assert.equal(client.sessionId, session.sessionId);
    assert.equal(answer.trim(), token, "second answer must recall the first turn");
  } catch (error) { failure = error; }
  finally {
    // Deliberately generous, and ONLY here. A probe exists to prove the child
    // exits, so it must not be the thing that killed it — but this is not
    // evidence that a teardown needs the time. Measured on a Mac against the
    // real CLI, twice, at the host's own default: 30ms, child exiting cleanly.
    // The product uses the same three-second budget as every other provider.
    await client.dispose(40_000);
    const code = await bounded(exit, 5000, "adapter exit observation");
    const observed = /MUSE_CHILD_EXIT (\{[^\r\n]+\})/.exec(diagnostics);
    assert.ok(observed, "adapter must report an awaited muse serve child exit");
    const child = JSON.parse(observed[1]);
    console.log(`OBSERVED muse serve child exit (awaited by adapter): ${JSON.stringify(child)}`);
    assert.deepEqual(child, { code: 0, signal: null });
    assert.equal(code, 0, "adapter must exit cleanly");
  }
  if (failure) throw failure;
  const terminals = [...diagnostics.matchAll(/Muse turn completed: (\{[^\r\n]+\})/g)].map(match => JSON.parse(match[1]));
  assert.equal(terminals.length, 2, "both turns need observed completion");
  assert.ok(terminals.every(turn => turn.terminal === "completed"));
  console.log("PASS: two correct turns in one real Muse session; both processes exited cleanly.");
}

main().catch(error => { console.error(`FAIL: ${error.stack || error}`); process.exitCode = 1; });
