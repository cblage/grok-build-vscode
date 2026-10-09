import type { WebContents } from "electron";

/** Installed in both packaged and development windows; independent of DevTools. */
export function installDesktopZoomHandlers(
  contents: Pick<WebContents, "on" | "setZoomFactor">,
  applyCssZoom: (kind: "in" | "out" | "reset") => void,
): void {
  // Electron 33 reports native wheel zoom requests here, not before-input-event.
  // Keep Chromium at 100%; the renderer owns the explicit CSS zoom controls.
  contents.on("zoom-changed", () => contents.setZoomFactor(1));

  contents.on("before-input-event", (event, input) => {
    if (!(input.control || input.meta) || input.alt) return;
    const key = input.key;
    let kind: "in" | "out" | "reset";
    if (key === "+" || key === "=" || key === "Add") kind = "in";
    else if (key === "-" || key === "Subtract") kind = "out";
    else if (key === "0" || ((key === "Digit0" || key === "Numpad0") &&
      (input.code === "Digit0" || input.code === "Numpad0"))) kind = "reset";
    else return;

    // Prevent renderer dispatch and menu accelerators too, so a key steps once.
    event.preventDefault();
    if (input.type === "keyDown") applyCssZoom(kind);
  });
}
