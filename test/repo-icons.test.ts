/**
 * The two generated lists must stay one list.
 *
 * `scripts/gen-repo-icons.mjs` emits `media/repo-icons.js` (what the picker
 * draws) and `src/repo-icon-ids.ts` (what the host will accept). They are
 * written from one table in one run, so they agree the moment they are
 * generated — and they drift the first time somebody hand-edits one of them.
 * The failure is silent and one-sided: the picker offers a mark, the user picks
 * it, `setRepoIcon` drops it on the floor, and nothing anywhere says why.
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ICON_IDS, isRepoIcon } from "../src/sessions";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

interface Marks {
  VIEW_BOX: string;
  DEFAULT_ID: string;
  GROUPS: { id: string; label: string; icons: [string, string][] }[];
  IDS: string[];
  has: (id: string) => boolean;
  labelFor: (id: string) => string;
  svg: (id: string) => string;
}

function loadMarks(): Marks {
  const window = new Window({ url: "https://example.test/" });
  window.eval(read("../media/repo-icons.js"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).GrokRepoIcons as Marks;
}

const marks = loadMarks();

describe("project mark catalogue", () => {
  it("offers the host exactly the ids the host accepts", () => {
    expect([...marks.IDS].sort()).toEqual([...REPO_ICON_IDS].sort());
    for (const id of marks.IDS) expect(isRepoIcon(id)).toBe(true);
  });

  it("puts every choosable mark in exactly one group, and the default in none", () => {
    const grouped = marks.GROUPS.flatMap((g) => g.icons.map(([id]) => id));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped).not.toContain(marks.DEFAULT_ID);
    // The default is still a legitimate value on the wire — it is only absent
    // from the picker, so that one appearance never has two controls.
    expect(marks.has(marks.DEFAULT_ID)).toBe(true);
    expect(isRepoIcon(marks.DEFAULT_ID)).toBe(true);
    expect([...grouped, marks.DEFAULT_ID].sort()).toEqual([...marks.IDS].sort());
  });

  it("draws every id on one grid, and nothing for an id it does not know", () => {
    for (const id of marks.IDS) {
      const svg = marks.svg(id);
      expect(svg, id).toContain(`viewBox="${marks.VIEW_BOX}"`);
      expect(svg, id).toContain('fill="currentColor"');
      // A mark with no path renders as an empty box — the exact failure the
      // relay's screens gate was written for, cheaper to catch here.
      expect(/\sd="[^"]{10,}"/.test(svg), id).toBe(true);
      // The default is drawn but never offered, so it alone has no label: the
      // picker's own cell says "Default folder" and stores "" (no mark).
      if (id !== marks.DEFAULT_ID) expect(marks.labelFor(id).length, id).toBeGreaterThan(0);
    }
    expect(marks.svg("")).toBe("");
    expect(marks.svg("not_a_material_symbol")).toBe("");
    expect(marks.has("not_a_material_symbol")).toBe(false);
  });

  it("takes an empty choice as 'no mark' and refuses anything else", () => {
    expect(isRepoIcon("")).toBe(true);
    expect(isRepoIcon("not_a_material_symbol")).toBe(false);
    expect(isRepoIcon(undefined)).toBe(false);
    expect(isRepoIcon(null)).toBe(false);
    expect(isRepoIcon(7)).toBe(false);
  });

  it("names every mark distinctly, so the search box can tell them apart", () => {
    const labels = marks.GROUPS.flatMap((g) => g.icons.map(([, label]) => label.toLowerCase()));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/**
 * Every host that draws a mark must SIZE it, and the two rails must agree.
 *
 * `marks.svg()` emits a viewBox-only `<svg>` on purpose -- the comment on it
 * says the hosts size it through CSS, as they do for every other icon. That
 * makes the sizing rule part of the contract rather than a detail, and a host
 * that forgets it does not degrade gracefully: inside a flex host (the chip and
 * the switcher row are both `display: inline-flex`) an unsized svg has no
 * intrinsic size to resolve a flex-basis from, so it collapses to 0x0 and
 * `flex: none` never grows it -- the mark VANISHES. In a non-flex host the same
 * omission renders it at 72px instead. One missing rule, two opposite symptoms,
 * neither visible to a suite that only asks which path data was drawn.
 *
 * Measured, before the rules below existed: chip 0x0, switcher row 0x0, rail
 * 14x14. The glyph the first two replaced (ICON.folder) carried width="13"
 * height="13" on the element, which is why nothing had needed a rule before.
 */
describe("the marks are sized wherever they are drawn", () => {
  const chatCss = read("../media/chat.css");
  const railCss = read("../media/projects-rail.css");

  // A mark host, and the stylesheet that has to size it. The rail and the panel
  // title were already right; the chip and the switcher row are what shipped
  // broken, and a fifth host added later belongs in this table.
  const hosts: [string, string, string][] = [
    ["rail twisty (desktop + phone)", chatCss, "rail-twisty"],
    ["rail twisty (VS Code side bar)", railCss, "rail-twisty"],
    ["composer chip", chatCss, "repo-chip-icon"],
    ["project switcher row", chatCss, "repo-row-icon"],
  ];

  it.each(hosts)("%s sizes the svg it hosts", (_label, css, cls) => {
    // Read the declaration block rather than pattern-matching the whole file:
    // a regex built by interpolating the class name needs its escapes doubled
    // through a template literal, and getting that wrong yields a pattern that
    // silently matches nothing -- a test that passes for the wrong reason is
    // worse here than no test, since this whole block exists to catch silence.
    const at = css.indexOf(`.${cls} svg {`);
    expect(at, `${cls}: no rule sizes the svg this host draws`).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    const width = /width:\s*([^;]+)/.exec(block)?.[1]?.trim();
    expect(width, `${cls}: its svg rule sets no width`).toBeTruthy();
    expect(width).not.toMatch(/^(auto|0)$/);
  });

  it("gives a conversation under a project a deeper indent than one under Pinned", () => {
    // Both rails, because they are the same geometry and the owner reported the
    // flat version of this from a phone -- which is chat.css, not the side bar.
    for (const css of [chatCss, railCss]) {
      expect(css).toMatch(/--rail-indent-nested:\s*32px/);
      expect(css).toMatch(/\.rail-sessions\s+\.rail-session\s*\{[^}]*padding-left:\s*var\(--rail-indent-nested\)/);
    }
  });

  it("draws the project's mark at the size the design asks for", () => {
    // 16px, and on BOTH sheets. The mark used to ride --rail-icon-size, which
    // is 14 -- so it drew smaller than the action icons on its own row, and
    // smaller than the design it came from. A number that lives in two files
    // drifts in one of them; that is what this asserts against.
    for (const css of [chatCss, railCss]) {
      expect(css).toMatch(/--rail-mark-size:\s*16px/);
      expect(css).toMatch(/\.rail-twisty\s+svg\s*\{[^}]*var\(--rail-mark-size\)/);
    }
  });

  it("lets a filtered-out mark actually disappear, on both sheets", () => {
    // `.repo-icon-cell` declares `display: grid`, so the UA stylesheet's
    // [hidden] { display: none } loses to it and the attribute the filter sets
    // does nothing on its own. Both the category tabs and the search box run
    // through that attribute, so without this rule both controls are inert
    // while looking perfectly healthy -- reported from a phone as "clicking
    // icon categories does nothing".
    for (const css of [chatCss, railCss]) {
      expect(css).toMatch(/\.repo-icon-cell\[hidden\]\s*\{[^}]*display:\s*none/);
    }
  });

  it("grows the mark with the glyphs beside it on touch", () => {
    // Only chat.css: the side bar is never a touch surface, and its action
    // glyphs stay 14px there, so its mark leads at 16 as the design intends.
    // Here every other glyph on the row is 20px, and a 16px mark beside them
    // reads as the lesser control -- which is what was reported from a phone.
    const touch = chatCss.slice(chatCss.indexOf("@media (hover: none) {"));
    expect(touch.slice(0, touch.indexOf("}"))).toMatch(/--rail-mark-size:\s*20px/);
  });

  it("gives the chevron a fixed box, so expanding does not shift the row", () => {
    // chevronRight is 14px and chevronDown is 12px, so without a box of its own
    // the mark and the name step sideways on every fold.
    for (const css of [chatCss, railCss]) {
      expect(css).toMatch(/\.rail-chevron\s*\{[^}]*width:\s*16px/);
      expect(css).toMatch(/\.rail-chevron\s+svg\s*\{[^}]*width:\s*12px/);
    }
  });
});
