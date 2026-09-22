/**
 * Which platforms keep the app in a tray when its window is closed (#174).
 *
 * This lives at the top level rather than in `src/desktop/` for a mechanical
 * reason worth knowing: `.vscodeignore` deliberately keeps `out/desktop/**` out
 * of the VS Code vsix, with a hand-listed exception per module the extension
 * genuinely requires at runtime — and `check:vsix` fails packaging when an
 * import crosses that boundary without one. `sidebar.ts` needs this predicate
 * to tell the settings page whether to offer the row, and a tray module is not
 * something the VS Code extension should be shipping to get it.
 *
 * So the rule has one definition, `src/desktop/tray.ts` re-exports it for the
 * desktop app, and neither copy can drift from the other.
 *
 * macOS is excluded, and NOT because it needs nothing. `main.ts` quits on
 * `window-all-closed` with no darwin exception, so closing the window ends the
 * app there exactly as it did before any of this. What macOS wants is its own
 * convention — the app outliving its last window, the dock icon bringing it
 * back — which destroys the window rather than hiding it, so `activate` has to
 * rebuild it. That is a different mechanism from this one, not a wider
 * platform list.
 */
export function trayIsSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}
