// Real phone layout/paint check: npm run e2e:workflow-header
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
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
      const page = await browser.newPage({ viewport: { width, height: 844 } });
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
          currentPhase: "Verify", elapsedMs: 106000, done: false,
          phases: ["Plan", "Research", "Verify", "Report"].map(title => ({ title, state: title === "Verify" ? "active" : "pending" })),
          agents: Array.from({ length: 16 }, (_, i) => ({
            id: `a${i}`, label: `Researcher ${i}`, phase: i === 0 ? "Plan" : "Research",
            state: "done", tokensUsed: i === 0 ? 23552 : 288307,
          })),
        },
      } })));
      const header = page.locator(".workflow-pin-run > .workflow-heading");
      const phase = header.locator(".run-progress-phase");
      assert.equal(await phase.textContent(), "· Verify");
      assert.equal(await phase.evaluate(el => getComputedStyle(el).clipPath), "none");
      assert.equal(await header.locator(".run-progress-elapsed").textContent(), "1:46");
      await header.locator("button").click();
      assert.equal(await phase.evaluate(el => getComputedStyle(el).clipPath), "inset(50%)");
      const rows = page.locator(".workflow-pin-run .workflow-agent");
      for (const row of await rows.all()) {
        await row.locator("button").click();
        assert.doesNotMatch(await row.locator(".workflow-agent-activity").innerText(), /no token activity observed/,
          "a positive token total must not appear beside a no-activity claim");
        assert.doesNotMatch(await row.locator(".workflow-agent-state").innerText(), /reported/,
          "agent states must omit the reported prefix");
      }
      assert.equal(await rows.nth(0).locator(".workflow-agent-state").innerText(), "Plan · done · 23.55K tokens");
      assert.equal(await rows.nth(1).locator(".workflow-agent-state").innerText(), "Research · done · 288K tokens");
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
      await page.close();
      passed++;
    }
  }
  console.log(`${passed} phone header layout/paint and agent text cases passed (320/390px, dark/light, fallback/translucent/opaque fills)`);
} finally {
  await browser.close();
}
