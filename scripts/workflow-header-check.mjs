// Real phone layout/paint check: npm run e2e:workflow-header
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const statelessRuns = JSON.parse(read("test/fixtures/workflow-stateless-phases.json")).runs;
const outputRuns = JSON.parse(read("test/fixtures/workflow-output.json")).runs;
const body = read("test/webview-harness.ts").match(/export const BODY = `([\s\S]*?)`;/)[1];
const shell = read("src/desktop/electron-webview.ts");
const palette = shell.match(/:root \{[\s\S]*?\n\}/)[0];
const light = shell.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)[0];
const chrome = process.env.COMPOSER_CHROMIUM || (process.platform === "win32"
  && existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
  ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
let passed = 0;
try {
  for (const width of [320, 390]) for (const theme of ["dark", "light"]) {
    for (const tint of ["initial", "rgba(127, 127, 127, 0.18)", "#304050"]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${palette}${light}${read("media/chat.css")}
        :root { --vscode-textBlockQuote-background: ${tint}; }</style>
        </head><body>${body}</body></html>`);
      await page.evaluate(() => {
        window.grokRemoteClient = true;
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
      });
      for (const script of ["webview-helpers", "settings", "file-panel", "chat"]) {
        await page.addScriptTag({ content: read(`media/${script}.js`) });
      }
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "runProgress", update: {
          kind: "workflow", id: "header-check", displayName: "deep-research", phase: "running",
          subtitle: "Research the first powered flight",
          currentPhase: "Verify", elapsedMs: 106000, done: false,
          phases: ["Plan", "Research", "Verify", "Report"].map(title => ({ title, state: title === "Verify" ? "active" : "pending" })),
          agents: Array.from({ length: 16 }, (_, i) => ({
            id: `a${i}`, label: `Researcher ${i}`, phase: i === 0 ? "Plan" : "Research",
            state: "done", tokensUsed: i === 0 ? 23552 : 288307,
          })),
        },
      } })));
      const header = page.locator(".workflow-pin-run > .workflow-heading");
      const checkDisclosure = async (button, selector, open) => {
        const icon = button.locator(selector);
        assert.equal(await icon.locator("svg path").getAttribute("d"), open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6");
        assert.equal(await icon.getAttribute("aria-hidden"), "true");
        assert.equal(await icon.locator("svg").evaluate(el => getComputedStyle(el).width), "12px");
        assert.equal(await icon.locator("svg").evaluate(el => getComputedStyle(el).height), "12px");
        assert.ok((await button.boundingBox()).height >= 36, "disclosure needs the existing 36px touch target");
        assert.equal(await icon.evaluate(el => getComputedStyle(el, "::before").content), "none");
        assert.equal(await button.evaluate(el => getComputedStyle(el, "::after").content), "none");
      };
      await checkDisclosure(header.locator("button"), ".workflow-chevron", false);
      const phase = header.locator(".run-progress-phase");
      assert.equal(await phase.textContent(), "Verify");
      assert.equal(await phase.evaluate(el => getComputedStyle(el).clipPath), "none");
      assert.equal(await header.locator(".run-progress-elapsed").textContent(), "1:46");
      await header.locator("button").click();
      await checkDisclosure(header.locator("button"), ".workflow-chevron", true);
      assert.equal(await phase.textContent(), "");
      assert.deepEqual(await page.locator(".workflow-pin-run").evaluate(el => {
        const purpose = el.querySelector(".run-progress-sub");
        const progress = el.querySelector(".workflow-progress");
        return { purpose: purpose.innerText,
          summaryFirst: purpose.getBoundingClientRect().bottom <= progress.getBoundingClientRect().top,
          clock: progress.querySelector(".run-progress-elapsed")?.textContent };
      }), { purpose: "Research the first powered flight", summaryFirst: true, clock: "1:46" });
      const rows = page.locator(".workflow-pin-run .workflow-agent");
      assert.equal(await rows.locator("button, .workflow-agent-chevron").count(), 0,
        "a positive-total snapshot has no observed activity to disclose");
      // A subsequent increase supplies real detail; disclosures must appear.
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "runProgress", update: {
          kind: "workflow", id: "header-check", displayName: "deep-research", phase: "running",
          currentPhase: "Verify", elapsedMs: 106000, done: false,
          phases: ["Plan", "Research", "Verify", "Report"].map(title => ({ title, state: title === "Verify" ? "active" : "pending" })),
          agents: Array.from({ length: 16 }, (_, i) => ({
            id: `a${i}`, label: `Researcher ${i}`, phase: i === 0 ? "Plan" : "Research",
            state: "done", tokensUsed: i === 0 ? 23553 : 288308,
          })),
        },
      } })));
      for (const row of await rows.all()) {
        await checkDisclosure(row.locator("button"), ".workflow-agent-chevron", false);
        await row.locator("button").click();
        await checkDisclosure(row.locator("button"), ".workflow-agent-chevron", true);
        assert.doesNotMatch(await row.locator(".workflow-agent-activity").innerText(), /no token activity observed/,
          "a positive token total must not appear beside a no-activity claim");
        assert.doesNotMatch(await row.locator(".workflow-agent-state").innerText(), /reported/,
          "agent states must omit the reported prefix");
      }
      // The phase belongs to the composed name now, so the metadata run carries
      // state and spend only -- no row may print its phase twice.
      assert.equal(await rows.nth(0).locator(".workflow-agent-state").innerText(), "done · 23.55K tokens");
      assert.equal(await rows.nth(1).locator(".workflow-agent-state").innerText(), "done · 288K tokens");
      // "Researcher 0" adds nothing to "Plan", so the phase leads it; "Researcher 1"
      // already reads as its own phase and must stand alone rather than become
      // "Research / Researcher 1".
      assert.equal(await rows.nth(0).locator(".workflow-agent-name").innerText(), "Plan / Researcher 0");
      assert.equal(await rows.nth(1).locator(".workflow-agent-name").innerText(), "Researcher 1");
      const checkLayout = async () => page.evaluate(() => {
        const card = document.querySelector(".workflow-pin-run");
        const header = card.querySelector(".workflow-heading");
        const scroll = document.querySelector(".workflow-pin-runs");
        const c = card.getBoundingClientRect(), h = header.getBoundingClientRect();
        return {
          fullWidth: h.left === c.left + parseFloat(getComputedStyle(card).borderLeftWidth) && h.right === c.right,
          radius: getComputedStyle(card).borderRadius,
          clipping: getComputedStyle(card).overflow,
          overflow: scroll.scrollWidth > scroll.clientWidth,
          sameFill: getComputedStyle(header).background === getComputedStyle(card).background,
          sticky: Math.abs(h.top - scroll.getBoundingClientRect().top) < 1,
        };
      });
      const before = await checkLayout();
      assert.equal(before.fullWidth, true);
      assert.equal(before.radius, "6px");
      assert.equal(before.clipping, "clip");
      assert.equal(before.overflow, false);
      assert.equal(before.sameFill, true);
      await page.locator(".workflow-pin-runs").evaluate(el => { el.scrollTop = 80; });
      assert.equal((await checkLayout()).sticky, true);
      // Change the actual scrolled body beneath the header. Its pixels must
      // remain identical: computed background values alone cannot prove opacity.
      // Only whole pixels inside the header: locator screenshots round outward
      // and can include a row of the body below a fractional layout boundary.
      const box = await header.boundingBox();
      const clip = { x: Math.ceil(box.x), y: Math.ceil(box.y),
        width: Math.floor(box.x + box.width) - Math.ceil(box.x),
        height: Math.floor(box.y + box.height) - Math.ceil(box.y) };
      const shot = await page.screenshot({ clip });
      await page.locator(".workflow-expanded").evaluate(el => { el.style.background = "#ff00ff"; });
      const after = await page.screenshot({ clip });
      if (!shot.equals(after)) {
        writeFileSync(join(tmpdir(), "workflow-header-before.png"), shot);
        writeFileSync(join(tmpdir(), "workflow-header-after.png"), after);
        console.log({ width, theme, tint, bounds: await header.boundingBox() });
      }
      assert.ok(shot.equals(after), "scrolled body shows through header");
      await header.locator("button").click();
      assert.equal(await phase.evaluate(el => getComputedStyle(el).clipPath), "none");
      assert.equal((await checkLayout()).overflow, false);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "runProgress", update: {
          kind: "workflow", id: "header-check", displayName: "deep-research", phase: "complete",
          currentPhase: "Report", elapsedMs: 390000, done: true, detail: "Partial · 6 of 16 agents used",
          phases: ["Plan", "Research", "Verify", "Report"].map(title => ({ title, state: title === "Report" ? "active" : "done" })),
        },
      } })));
      assert.equal(await page.locator(".workflow-pin, .workflow-marker, .run-progress-btn").count(), 0);
      const report = page.locator(".workflow-report");
      assert.equal(await report.evaluate(el => el.open), false, "settled report must arrive closed");
      assert.equal(await report.locator(".workflow-report-name").textContent(), "deep-research");
      assert.equal(await report.locator(".workflow-report-state").textContent(), "done");
      // The finished card reports its duration without being opened, and
      // draws OUR chevron on the right rather than the UA details marker.
      assert.equal(await report.locator(".workflow-report-elapsed").textContent(), "6:30");
      assert.equal(await report.locator(".workflow-report-chevron svg").count(), 1);
      assert.equal(await report.locator(".workflow-report-dots .workflow-dot").count(), 4);
      assert.deepEqual(await report.locator(".workflow-report-dots .workflow-dot").evaluateAll(
        (dots) => dots.map((d) => d.dataset.state)), ["done", "done", "done", "done"]);
      assert.equal(await report.locator("summary").evaluate(
        (el) => getComputedStyle(el).listStyleType), "none");
      // The summary IS the control that opens the report, so it carries the
      // same coarse-pointer target as the live card's disclosure button. It
      // did not, and a line of text is not reliably tappable.
      assert.ok((await report.locator("summary").boundingBox()).height >= 36,
        "the finished report's summary needs the 36px touch target");
      await report.locator("summary").click();
      assert.equal(await report.locator('.workflow-phase[data-state="done"]').count(), 4);
      assert.equal(await report.locator('[aria-current="step"]').count(), 0);
      assert.equal(await report.locator(".workflow-output").count(), 0, "legacy detail has no output provenance");
      assert.match(await report.locator(".workflow-phase").last().evaluate(el => getComputedStyle(el, "::before").content), /✓/);
      // A finished report has one disclosure -- the summary. Its own
      // heading chevron must actually disappear, not just carry `hidden`.
      assert.equal(await report.locator(".workflow-chevron").evaluate(el => el.checkVisibility()), false,
        "a finished report keeps a dead heading chevron visible");
      // A run that stopped mid-stage must not paint the interrupted step
      // the same hollow ○ as a step that was never reached.
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "runProgress", update: {
          kind: "workflow", id: "header-check-2", displayName: "deep-research", phase: "failed",
          currentPhase: "Research", elapsedMs: 90000, done: true, failed: true,
          phases: ["Plan", "Research", "Verify", "Report"].map(title => ({ title, state: title === "Plan" ? "done" : title === "Research" ? "active" : "pending" })),
        },
      } })));
      const failedReport = page.locator(".workflow-report").last();
      await failedReport.locator("summary").click();
      const interrupted = failedReport.locator(".workflow-phase").nth(1);
      const pending = failedReport.locator(".workflow-phase").nth(2);
      assert.match(await interrupted.evaluate(el => getComputedStyle(el, "::before").content), /✕/);
      const interruptedColor = await interrupted.evaluate(el => getComputedStyle(el).color);
      const pendingColor = await pending.evaluate(el => getComputedStyle(el).color);
      assert.notEqual(interruptedColor, pendingColor, "an interrupted step must not read identically to one never reached");
      for (const historical of [false, true]) {
        await page.evaluate(({ runs, historical }) => {
          const send = data => window.dispatchEvent(new MessageEvent("message", { data }));
          send({ type: "clearMessages" });
          send({ type: "historyReplay", active: historical });
          for (const run of runs) send({ type: "runProgress", update: {
            kind: "workflow", id: run.run_id, title: run.name, displayName: run.name,
            // The old host knew the phase word but did not recognize `complete`.
            phase: run.state.status, done: false, currentPhase: run.state.current_phase,
            phases: run.state.phases, elapsedMs: run.state.elapsed_ms_floor,
            agents: run.state.agents.map(a => ({ id: a.agent_id, label: a.label, phase: a.phase, state: a.state, tokensUsed: a.tokens_used })),
          } });
          send({ type: "historyReplay", active: false });
        }, { runs: statelessRuns, historical });
        assert.equal(await page.locator(".workflow-pin, .workflow-marker, .run-progress-btn").count(), 0);
        assert.deepEqual(await page.locator(".workflow-report").evaluateAll(els => els.map(el => el.open)), [false, false]);
        assert.deepEqual(await page.locator(".workflow-report-name").allTextContents(), ["demo-stages", "demo-stages-2"]);
        for (const report of await page.locator(".workflow-report").all()) await report.locator("summary").click();
        assert.equal(await page.locator('.workflow-phase[data-state="done"]').count(), 4);
        assert.equal(await page.locator(".workflow-agent button, .workflow-agent-chevron").count(), 0);
      }
      // Source-preserving hosts and legacy hosts use the same phone client.
      for (const legacy of [false, true]) {
        await page.evaluate(({ runs, legacy }) => {
          const send = data => window.dispatchEvent(new MessageEvent("message", { data }));
          send({ type: "clearMessages" });
          for (const run of runs) send({ type: "runProgress", update: {
            kind: "workflow", id: run.run_id, title: run.name, displayName: run.name,
            phase: run.status, done: true, cancelled: run.status === "cancelled",
            subtitle: run.objective, currentPhase: run.current_phase, phases: run.phases,
            elapsedMs: run.elapsed_ms, agentsUsed: run.agents_used, agentBudget: run.agent_budget,
            agents: run.agents.map(a => ({ id: a.agent_id, label: a.label, phase: a.phase, state: a.state, tokensUsed: a.tokens_used })),
            detail: `${run.current_phase} · ${run.result_summary || "Workflow outcome ignored: ignored cancelled while status is cancelled"} · ${run.agents_used} of ${run.agent_budget} agents used`,
            ...(!legacy ? { workflowContent: { resultSummary: run.result_summary || null, pauseMessage: null } } : {}),
          } });
        }, { runs: outputRuns, legacy });
        for (const [index, report] of (await page.locator(".workflow-report").all()).entries()) {
          await report.locator("summary").click();
          const layout = await report.evaluate(el => {
            const blocks = [...el.querySelectorAll(".run-progress-sub, .workflow-progress, .workflow-output, .workflow-roster")];
            const rects = blocks.map(b => b.getBoundingClientRect());
            return {
              order: blocks.map(b => b.className),
              stacked: rects.every((r, i) => i === 0 || r.top >= rects[i - 1].bottom),
              overflow: el.scrollWidth > el.clientWidth,
              phase: el.querySelector(".run-progress-phase").textContent,
              output: el.querySelector(".workflow-output-body")?.innerText ?? null,
              headings: el.querySelectorAll(".workflow-output h3").length,
              diagnostic: el.innerText.includes("ignored cancelled"),
            };
          });
          assert.deepEqual(layout, {
            order: ["run-progress-sub", "workflow-progress", ...(!legacy && index < 2 ? ["workflow-output"] : []), "workflow-roster"],
            stacked: true, overflow: false, phase: "",
            output: legacy || index === 2 ? null : index === 1 ? "The workflow finished its first step." :
              "Status: Partial — see the full report for coverage gaps.\n\nOn 17 December 1903, Orville Wright piloted the Wright Flyer. [S5]\nWhy earlier attempts do not count\nOn 14 December Wilbur Wright made a downhill start.\nThe other flights that morning\nThe brothers alternated. [S2][S11]\n\nFull report: scratch/report.md",
            headings: !legacy && index === 0 ? 2 : 0, diagnostic: false,
          });
        }
      }
      // The standalone editor rail has its own stylesheet and renderer.
      // Check its real controls too; chat.css cannot fix that webview.
      await page.setContent(`<style>${palette}${read("media/projects-rail.css")}</style>
        <aside id="projects-rail"><input id="rail-search"><div id="rail-scroll"></div></aside>`);
      for (const script of ["webview-helpers", "repo-icons", "repo-icon-picker", "projects-rail"]) {
        await page.addScriptTag({ content: read(`media/${script}.js`) });
      }
      await page.evaluate(() => window.__grokProjectsRail.onMessage({ type: "repos",
        entries: [{ cwd: "/work/demo", label: "demo", available: true, updatedAt: 1 }],
        selectedCwd: "/work/demo", activeCwd: "/work/demo",
      }));
      await page.evaluate(() => window.__grokProjectsRail.onMessage({ type: "sessions",
        entries: [{ id: "demo-session", cwd: "/work/demo", displayName: "Demo", numMessages: 2, updatedAt: 1, createdAt: 1 }],
        activeId: null, dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "",
      }));
      for (const selector of [".rail-head-btn", ".rail-repo-head"]) {
        const buttons = await page.locator(selector).all();
        assert.ok(buttons.length > 0, `${selector} must be exercised`);
        for (const button of buttons) {
          assert.ok((await button.boundingBox()).height >= 36, `${selector} needs a 36px touch target`);
        }
      }
      await page.close();
      passed++;
    }
  }
  console.log(`${passed} phone header layout/paint, agent text and completion cases passed (320/390px, dark/light, fallback/translucent/opaque fills)`);
} finally {
  await browser.close();
}
