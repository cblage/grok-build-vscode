import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #172 — the composer toolbar sheds things as it narrows, and it was shedding
 * them in the wrong order.
 *
 * `@container composer-card (max-width: Npx)` rungs fire as the composer gets
 * narrower, so a LARGER N means the rule bites EARLIER — the first thing to go.
 * The context figure used to go first, at 470px, on the reasoning that nothing
 * in the message depends on it and the tooltip still carries it. True, and
 * beside the point: two people reported the same thing independently —
 *
 *   "the priority should be to ensure the context is displayed first, and then
 *    the model name"
 *   "I check the context window size much more than the model name"
 *
 * — because the model name is the one piece of that toolbar they already know,
 * having picked it, while the context figure is the readout they actually
 * watch.
 *
 * No DOM suite can catch an inversion here: container queries do not evaluate
 * under happy-dom, and the defect is the RELATIVE ORDER of rules rather than
 * anything any one of them does. So it is asserted against the stylesheet, the
 * same way `confirm-stacking.test.ts` asserts a relationship between layers.
 */

const css = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "media", "chat.css"),
  "utf8",
);

type Rung = { width: number; body: string; nested: boolean };

/**
 * Every `@container composer-card (max-width: Npx)` block, with whether it sits
 * inside another at-rule. The touch branch has its OWN ladder under
 * `@media (hover: none)`, tuned by tap-target geometry rather than by priority,
 * and mixing the two would compare rungs that never apply together.
 */
function rungs(): Rung[] {
  const found: Rung[] = [];
  const re = /@container\s+composer-card\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    // Brace depth at this point tells us whether we are nested, without relying
    // on how the file happens to be indented.
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    let end = re.lastIndex;
    for (let d = 1; d > 0 && end < css.length; end++) {
      if (css[end] === "{") d++;
      else if (css[end] === "}") d--;
    }
    found.push({
      width: Number(m[1]),
      body: css.slice(re.lastIndex, end - 1),
      nested: depth > 0,
    });
  }
  return found;
}

const all = rungs();
const desktop = all.filter((r) => !r.nested);

describe("the composer's collapse ladder keeps the context figure longest (#172)", () => {
  it("finds the ladder at all", () => {
    // If this ever goes to zero the rest of the file passes vacuously, which is
    // the failure mode of every assertion made against source text.
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(desktop.length).toBeGreaterThanOrEqual(4);
  });

  const hidesDonutNumbers = (r: Rung) => /#donut-label\s*\{[^}]*display:\s*none/.test(r.body);
  const touchesTheChip = (r: Rung) =>
    /\.model-chip-name|\.model-chip-effort|#mode-btn\s+\.btn-label/.test(r.body);

  it("drops the model chip's own text before it drops the number", () => {
    const donut = desktop.filter(hidesDonutNumbers);
    const chip = desktop.filter(touchesTheChip);
    expect(donut).toHaveLength(1);
    expect(chip.length).toBeGreaterThanOrEqual(3);
    for (const rung of chip) {
      // Strictly wider: the chip rung must bite first. Equal widths would make
      // the order a question of source position, which is how this inverted.
      expect(rung.width).toBeGreaterThan(donut[0].width);
    }
  });

  it("makes the number the very last thing the desktop ladder gives up", () => {
    const narrowest = Math.min(...desktop.map((r) => r.width));
    const donut = desktop.find(hidesDonutNumbers)!;
    expect(donut.width).toBe(narrowest);
  });

  it("still has the effort label going first, since it is a tap away in the chip", () => {
    const widest = desktop.reduce((a, b) => (a.width >= b.width ? a : b));
    expect(widest.body).toMatch(/\.model-chip-effort\s*\{[^}]*display:\s*none/);
  });

  /**
   * The touch branch is deliberately NOT held to the order above. There
   * `#donut-label` is hidden unconditionally, for tap-target geometry: six
   * controls at a 36px floor need 224px of pure button. That is a different
   * argument from priority, and both #172 reporters are on a desktop. This
   * asserts the separation so a future edit does not read the rule above as
   * covering a surface it never covered.
   */
  it("leaves the touch branch's own reasoning alone", () => {
    const touch = css.slice(css.indexOf("@media (hover: none), (pointer: coarse) {"));
    expect(touch).toMatch(/#donut-label\s*\{\s*display:\s*none/);
    expect(all.some((r) => r.nested)).toBe(true);
  });
});
