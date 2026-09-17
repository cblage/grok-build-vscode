import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, openAppSettings } from "./webview-harness";

const backendState = { provider: "codex", preference: "auto", backend: "openai", hasXai: false, hasOpenAi: true,
  backends: { codex: "openai", grok: "openai", claude: "openai" } };

describe("voice Settings on every surface", () => {
  it("the row is host-backed and hidden until supporting data arrives, including standalone Settings", () => {
    const w = new Window({ url: "https://localhost/" });
    (w as any).eval(readFileSync(new URL("../media/webview-helpers.js", import.meta.url), "utf8"));
    (w as any).eval(readFileSync(new URL("../media/settings.js", import.meta.url), "utf8"));
    const api = (w as any).GrokSettings;
    (w as any).GrokVoiceSettings.install(api);
    (w as any).GrokVoiceSettings.install(api);
    expect(api.ROWS.filter((r: any) => r.id === "voiceBackend")).toHaveLength(1);
    const row = api.ROWS.find((r: any) => r.id === "voiceBackend");
    expect(row.localOnly).toBeUndefined();
    expect(row.message("openai")).toEqual({ type: "setVoiceBackend", value: "openai" });
    for (const env of [{}, { isDesktop: true }, { isRemote: true }]) {
      expect(api.visibleRows({}, env).some((r: any) => r.id === "voiceBackend")).toBe(false);
      expect(api.visibleRows({ voiceBackendState: backendState }, env).some((r: any) => r.id === "voiceBackend")).toBe(true);
    }
    const posted: any[] = []; const root = w.document.createElement("div"); w.document.body.appendChild(root);
    const surface = api.mount(root, { category: "voice", standalone: true, snapshot: { voiceBackendState: backendState }, post: (m: any) => posted.push(m) });
    const select = root.querySelector('[data-id="voiceBackend"] select') as any;
    expect(select).toBeTruthy(); select.value = "xai"; select.dispatchEvent(new w.Event("change", { bubbles: true }));
    expect(posted).toContainEqual({ type: "setVoiceBackend", value: "xai" });
    surface.update({ voiceBackendState: { ...backendState, preference: "xai" } });
    expect((root.querySelector('[data-id="voiceBackend"] select') as any).value).toBe("xai");
    expect(root.textContent).toContain("Codex / ChatGPT sign-in does not include transcription API access");
    surface.dispose(); w.happyDOM.abort();
  });

  it.each([false, true])("renders a usable OpenAI-only mic and picker (remote=%s)", remote => {
    const h = bootWebview({ remote, beforeScripts(w) {
      Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia() {} }, configurable: true });
      (w as any).AudioWorkletNode = function () {};
    } });
    dispatch(h.window, { type: "session", provider: "codex", models: [] });
    dispatch(h.window, { type: "providerState", providers: [{ id: "codex", connected: true }, { id: "grok", connected: false }] });
    openAppSettings(h.window, h.doc);
    const voice = [...h.doc.querySelectorAll(".settings-nav-item")].find(e => e.textContent === "Voice")!; click(h.window, voice);
    expect(h.doc.querySelector('[data-id="voiceBackend"]')).toBeNull();
    dispatch(h.window, { type: "voiceConfigured", value: true, backendState });
    expect(h.doc.querySelector('[data-id="voiceBackend"]')).toBeTruthy();
    const mic = h.doc.getElementById("mic-btn") as HTMLButtonElement;
    expect(mic.disabled).toBe(false); expect(mic.classList.contains("needs-setup")).toBe(false);
    expect(mic.title).not.toContain("Grok connected");
    // The host supplies every provider's resolution. A provider switch cannot
    // accidentally reuse the desk/provider boolean while waiting for a frame.
    dispatch(h.window, { type: "session", provider: "claude", models: [] });
    expect(mic.disabled).toBe(false); expect(mic.classList.contains("needs-setup")).toBe(false);
    h.window.happyDOM.abort();
  });

  it("an explicit missing backend displays setup even with another credential present", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "voiceConfigured", value: false,
      backendState: { ...backendState, preference: "xai", backend: undefined, backends: { grok: null, codex: null, claude: null } } });
    const mic = h.doc.getElementById("mic-btn")!;
    expect(mic.classList.contains("needs-setup")).toBe(true);
    click(h.window, mic); expect(h.posted).toContainEqual({ type: "voiceStart" });
    expect(h.doc.querySelector(".confirm-overlay")).toBeNull(); h.window.happyDOM.abort();
  });
});
