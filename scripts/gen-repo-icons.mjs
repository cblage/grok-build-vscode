#!/usr/bin/env node
/**
 * Regenerate the 96 project marks — `media/repo-icons.js` (the renderers' path
 * data) and `src/repo-icon-ids.ts` (the host's allowlist).
 *
 * BOTH come out of the one `GROUPS` table below, which is the point: a picker
 * offering an id the host rejects is a control that silently does nothing, and
 * two hand-maintained lists of 96 strings drift the first time anyone edits
 * one. `test/repo-icons.test.ts` re-checks the pair, for the case where someone
 * hand-edits a generated file instead of rerunning this.
 *
 * Run by hand, not by the build: the output is committed, because a webview
 * cannot fetch and a release must not depend on a CDN being up. Run it only
 * when the curated set below changes.
 *
 *   node scripts/gen-repo-icons.mjs
 *
 * Geometry comes from `@material-symbols/svg-400` on jsdelivr, which mirrors
 * Google's own Apache-2.0 release of Material Symbols. The `rounded` family at
 * FILL 1 is what the app uses; every glyph is asserted to be a single <path> on
 * the canonical `0 -960 960 960` grid, so a vendor change that splits a symbol
 * into two paths fails here rather than shipping a half-drawn mark.
 *
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The curated set, in the order the picker draws it. Chosen to name a project
 * rather than to act: no "add", no "delete", nothing that reads as a button.
 * Labels are written out rather than derived from the id — an auto title-case
 * prints "Sms" and "Rss feed", and "smart_toy" is the icon everyone calls a
 * robot.
 */
const GROUPS = [
  ["shapes", "Shapes", [
    ["hexagon", "Hexagon"], ["pentagon", "Pentagon"], ["square", "Square"], ["circle", "Circle"],
    ["diamond", "Diamond"], ["grid_view", "Grid"], ["bolt", "Bolt"], ["spa", "Spa"],
    ["eco", "Leaf"], ["star", "Star"], ["favorite", "Heart"], ["shield", "Shield"],
    ["encrypted", "Encrypted"], ["key", "Key"], ["extension", "Extension"], ["folder_open", "Folder"],
  ]],
  ["build", "Build", [
    ["rocket_launch", "Rocket launch"], ["rocket", "Rocket"], ["code", "Code"], ["terminal", "Terminal"],
    ["database", "Database"], ["cloud", "Cloud"], ["science", "Science"], ["construction", "Tools"],
    ["build", "Wrench"], ["drone", "Drone"], ["smart_toy", "Robot"], ["robot_2", "Robot 2"],
    ["hub", "Hub"], ["quiz", "Quiz"], ["lightbulb", "Lightbulb"], ["contactless", "Contactless"],
  ]],
  ["work", "Work", [
    ["work", "Briefcase"], ["domain", "Building"], ["paid", "Paid"], ["analytics", "Analytics"],
    ["pie_chart", "Pie chart"], ["finance", "Finance"], ["graph_2", "Graph"], ["trending_up", "Trending up"],
    ["receipt_long", "Receipt"], ["storefront", "Storefront"], ["savings", "Savings"], ["handshake", "Handshake"],
    ["inventory_2", "Inventory"], ["monitoring", "Monitoring"], ["workspace_premium", "Award"],
    ["planner_review", "Planner review"],
  ]],
  ["talk", "Talk", [
    ["mail", "Mail"], ["chat_bubble", "Chat bubble"], ["sms", "SMS"], ["forum", "Forum"],
    ["ring_volume", "Ring volume"], ["call", "Call"], ["contact_mail", "Contact card"],
    ["alternate_email", "At sign"], ["campaign", "Campaign"], ["rss_feed", "RSS feed"],
    ["voicemail", "Voicemail"], ["podcasts", "Podcast"], ["groups", "Groups"], ["diversity_3", "Diversity"],
    ["waving_hand", "Waving hand"], ["thumb_up", "Thumbs up"],
  ]],
  ["people", "People", [
    ["person", "Person"], ["person_2", "Person 2"], ["person_3", "Person 3"], ["person_4", "Person 4"],
    ["group", "Group"], ["emoji_people", "Person waving"], ["public", "Globe"], ["school", "School"],
    ["psychology", "Psychology"], ["pets", "Paw"], ["medication", "Medication"], ["celebration", "Celebration"],
  ]],
  ["play", "Play", [
    ["travel", "Travel"], ["trip", "Trip"], ["flight", "Flight"], ["luggage", "Luggage"],
    ["map", "Map"], ["explore", "Compass"], ["sailing", "Sailing"], ["hiking", "Hiking"],
    ["beach_access", "Beach"], ["directions_car", "Car"], ["train", "Train"], ["local_cafe", "Coffee"],
    ["restaurant", "Restaurant"], ["stadia_controller", "Controller"], ["sports_esports", "Gamepad"],
    ["music_note", "Music"], ["palette", "Palette"], ["brush", "Brush"], ["photo_camera", "Camera"],
    ["menu_book", "Book"],
  ]],
];

const VIEW_BOX = "0 -960 960 960";

/**
 * The mark a project wears when it has none of its own — and the fallback when
 * a stored id names a glyph this build does not ship.
 *
 * It is NOT offered as a choice in the picker: a cell that looks identical to
 * "Default" and stores a different value is two controls for one appearance.
 * It stays in PATHS and in the host allowlist because a client may legitimately
 * still send it.
 */
const DEFAULT_ID = "folder_open";

const entries = GROUPS.flatMap(([, , icons]) => icons);
const ids = entries.map(([id]) => id);
if (new Set(ids).size !== ids.length) throw new Error("duplicate icon id in the curated set");
if (new Set(entries.map(([, l]) => l)).size !== entries.length) throw new Error("duplicate label");
// Ids reach CSS selectors, dataset values and the wire — keep them boring.
const bad = ids.filter((id) => !/^[a-z0-9_]+$/.test(id));
if (bad.length) throw new Error("id is not [a-z0-9_]: " + bad.join(", "));
if (!ids.includes(DEFAULT_ID)) throw new Error("the default mark is not in the curated set");

const paths = {};
const failed = [];
for (const id of ids) {
  const url = `https://cdn.jsdelivr.net/npm/@material-symbols/svg-400/rounded/${id}-fill.svg`;
  const res = await fetch(url);
  if (!res.ok) { failed.push(`${id}: HTTP ${res.status}`); continue; }
  const svg = await res.text();
  const vb = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (vb !== VIEW_BOX) { failed.push(`${id}: viewBox ${vb}`); continue; }
  const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (d.length !== 1) { failed.push(`${id}: ${d.length} paths`); continue; }
  paths[id] = d[0];
  process.stdout.write(".");
}
process.stdout.write("\n");
if (failed.length) { console.error("FAILED:\n" + failed.join("\n")); process.exit(1); }

const q = (s) => JSON.stringify(s);
const groupLines = GROUPS.map(([id, label, icons]) =>
  `    { id: ${q(id)}, label: ${q(label)}, icons: [\n` +
  icons.filter(([i]) => i !== DEFAULT_ID).map(([i, l]) => `      [${q(i)}, ${q(l)}],`).join("\n") +
  `\n    ] },`).join("\n");
const pathLines = ids.map((id) => `    ${id}: ${q(paths[id])},`).join("\n");

const out = `/**
 * Project marks — the glyph a project wears in the conversation rail, on its
 * row in the project switcher, and above the file tree.
 *
 * Material Symbols Rounded at FILL 1, weight 400, on Google's canonical
 * 0 -960 960 960 grid. Apache-2.0 — see LICENSE-MATERIAL-SYMBOLS.md.
 *
 * FILLED on purpose. A 2px stroke inside a 16px box tints roughly a seventh of
 * the pixels a filled glyph does, which is why six distinguishable hues read as
 * one grey at rail size. The fill is what makes the colour visible; the colour
 * was never what made the mark legible.
 *
 * Inline path data rather than the Material Symbols webfont: a webview has no
 * network, the glyph has to inherit \`currentColor\` to carry the project tint,
 * and every other icon in this UI is already an inline SVG string.
 *
 * GENERATED by scripts/gen-repo-icons.mjs, together with src/repo-icon-ids.ts
 * (the host's allowlist) — do not hand-edit either one.
 */
(function (root) {
  "use strict";

  const VIEW_BOX = ${q(VIEW_BOX)};

  /**
   * The mark a project wears when it has chosen none, and the fallback for an
   * id this build does not ship. Deliberately absent from GROUPS: a picker cell
   * that looks identical to "Default" but stores a different value is two
   * controls for one appearance.
   */
  const DEFAULT_ID = ${q(DEFAULT_ID)};

  /** The choosable catalogue, in the order the picker draws its tabs. */
  const GROUPS = [
${groupLines}
  ];

  const PATHS = {
${pathLines}
  };

  /** Every id this build can draw, default included. */
  const IDS = Object.keys(PATHS);

  const LABEL_BY_ID = new Map(GROUPS.flatMap((g) => g.icons));

  /** Whether \`id\` names a mark this build ships. "" (no mark) is NOT an icon. */
  function has(id) {
    return typeof id === "string" && id !== "" && Object.prototype.hasOwnProperty.call(PATHS, id);
  }

  function labelFor(id) {
    return LABEL_BY_ID.get(id) || "";
  }

  const cache = new Map();

  /**
   * Markup for one mark, or "" for an unknown id — callers fall back to the
   * folder glyph rather than rendering an empty box. No width/height: the rail
   * and the file panel size \`svg\` through CSS, as they do for every other icon.
   */
  function svg(id) {
    if (!has(id)) return "";
    let hit = cache.get(id);
    if (hit === undefined) {
      hit = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + VIEW_BOX +
        '" fill="currentColor" aria-hidden="true"><path d="' + PATHS[id] + '"/></svg>';
      cache.set(id, hit);
    }
    return hit;
  }

  root.GrokRepoIcons = { VIEW_BOX, DEFAULT_ID, GROUPS, IDS, has, labelFor, svg };
})(typeof globalThis !== "undefined" ? globalThis : window);
`;

const idLines = [];
for (let i = 0; i < ids.length; i += 4) {
  idLines.push("  " + ids.slice(i, i + 4).map(q).join(", ") + ",");
}

const tsOut = `/**
 * The project-mark allowlist.
 *
 * GENERATED by scripts/gen-repo-icons.mjs, together with media/repo-icons.js
 * (the renderers' path data) — do not hand-edit either one. The two come out of
 * one table on purpose: the host rejects any id not in this list, so a picker
 * that offered one the host had never heard of would be a control that silently
 * does nothing.
 *
 * Order is the catalogue order the picker draws; nothing depends on it.
 */
export const REPO_ICON_IDS = [
${idLines.join("\n")}
] as const;
`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsDest = path.join(root, "media", "repo-icons.js");
const tsDest = path.join(root, "src", "repo-icon-ids.ts");
writeFileSync(jsDest, out);
writeFileSync(tsDest, tsOut);
console.log(`ok ${ids.length} marks -> ${jsDest} (${out.length} bytes), ${tsDest}`);
