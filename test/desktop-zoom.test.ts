import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { installDesktopZoomHandlers } from "../src/desktop/window-zoom";

function harness() {
  const contents = Object.assign(new EventEmitter(), { setZoomFactor: vi.fn() });
  const zoom = vi.fn();
  installDesktopZoomHandlers(contents as any, zoom);
  return { contents, zoom };
}

describe("desktop native zoom input", () => {
  it("installs zoom handlers unconditionally in createApp, outside the DevTools gate", () => {
    const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
    const createApp = file.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "createApp");
    expect(createApp?.body?.statements.some((node) =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(file) === "installDesktopZoomHandlers",
    )).toBe(true);
  });

  it.each(["in", "out"])("keeps native wheel zoom at 100%% (%s), without changing CSS scale", (direction) => {
    const { contents, zoom } = harness();
    contents.emit("zoom-changed", {}, direction);
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1);
    expect(zoom).not.toHaveBeenCalled();
  });

  it.each(["control", "meta"])("handles %s zoom shortcuts once, without requiring Shift", (modifier) => {
    const { contents, zoom } = harness();
    for (const [key, kind] of [["=", "in"], ["+", "in"], ["Add", "in"],
      ["-", "out"], ["Subtract", "out"], ["0", "reset"]]) {
      zoom.mockClear();
      for (const type of ["keyDown", "keyUp"]) {
        const event = { preventDefault: vi.fn() };
        contents.emit("before-input-event", event, { type, key, [modifier]: true, shift: key === "+" });
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
      expect(zoom).toHaveBeenCalledOnce();
      expect(zoom).toHaveBeenCalledWith(kind);
    }
  });

  it("leaves Alt combinations, unmodified keys and unrelated shortcuts alone", () => {
    const { contents, zoom } = harness();
    for (const input of [
      { key: "=", control: true, alt: true }, { key: "-", meta: true, alt: true },
      { key: "=" }, { key: "f", control: true }, { key: "_", control: true, shift: true },
    ]) {
      const event = { preventDefault: vi.fn() };
      contents.emit("before-input-event", event, { type: "keyDown", ...input });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(zoom).not.toHaveBeenCalled();
  });
});
