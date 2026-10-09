import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { execGrokCli } from "../src/cli-process";
import { parseMuseVersionOutput } from "../src/muse-cli-locator";

vi.mock("../src/cli-process", () => ({ execGrokCli: vi.fn() }));
const exec = vi.mocked(execGrokCli);

function harness() {
  const host = Object.create(GrokSidebar.prototype) as any;
  Object.assign(host, {
    providerCliVersions: {},
    providerConnections: () => ({ muse: true }),
    locatedProviders: () => ({ muse: true }),
    locateProvider: vi.fn(() => "/installed/muse"),
    host: { appendLine: vi.fn() },
    post: vi.fn(),
    settingsEditor: { webview: { postMessage: vi.fn() } },
  });
  return host;
}

beforeEach(() => exec.mockReset());

describe("Muse CLI version reporting", () => {
  it.each([
    // What the installed 1.3.0 launcher actually prints, read off a cloud host.
    ["Muse Code 1.3.0 (1.3.0-R3401.1)\n", "1.3.0-R3401.1"],
    ["muse 1.3.0-R3401.1\n", "1.3.0-R3401.1"],
    ["1.3.0", "1.3.0"],
    ["Muse Code v1.3.0", "1.3.0"],
    ["", ""],
    ["error: failed to start", ""],
  ])("parses %j without inventing a version", (output, version) => {
    expect(parseMuseVersionOutput(output)).toBe(version);
  });

  it("probes the installed CLI once and reports to chat/remotes and the settings tab", async () => {
    const host = harness();
    exec.mockResolvedValue({ stdout: "muse 1.3.0-R3401.1", stderr: "" });
    const versions = await Promise.all([host.probeProviderVersion("muse"), host.probeProviderVersion("muse")]);
    expect(versions).toEqual(["1.3.0-R3401.1", "1.3.0-R3401.1"]);
    expect(exec).toHaveBeenCalledTimes(1);
    // The signal is the consent lifetime: a disconnect aborts the read in
    // flight rather than letting a late answer land (#171).
    expect(exec).toHaveBeenCalledWith("/installed/muse", ["--version"],
      { timeout: 30_000, windowsHide: true, signal: expect.any(AbortSignal) });
    expect(host.locateProvider).toHaveBeenCalledWith("muse");
    const message = host.providerStateMessage();
    expect(message.providers.find((p: any) => p.id === "muse").cliVersion).toBe("1.3.0-R3401.1");
    expect(host.post).toHaveBeenCalledWith(message);
    expect(host.settingsEditor.webview.postMessage).toHaveBeenCalledWith(message);
  });

  it("re-reads Muse during a local-only Providers refresh without credential work", async () => {
    const host = harness();
    exec.mockResolvedValueOnce({ stdout: "muse 1.2.0", stderr: "" })
      .mockResolvedValueOnce({ stdout: "muse 1.3.0", stderr: "" });
    host.reprobeProviderCredentials = vi.fn();
    await host.probeProviderVersion("muse");
    await host.refreshProviderStates({ credentials: false });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(host.providerCliVersions.muse).toBe("1.3.0");
    expect(host.reprobeProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(["unreadable output", "failed spawn"])("omits an unknown version on %s and can retry", async failure => {
    const host = harness();
    if (failure === "failed spawn") exec.mockRejectedValueOnce(new Error("ENOENT"));
    else exec.mockResolvedValueOnce({ stdout: "not a version", stderr: "" });
    await expect(host.probeProviderVersion("muse")).resolves.toBe("");
    expect(host.providerStateMessage().providers.find((p: any) => p.id === "muse")).not.toHaveProperty("cliVersion");
    exec.mockResolvedValueOnce({ stdout: "muse 1.3.0", stderr: "" });
    await host.reprobeProviderVersion("muse");
    expect(host.providerCliVersions.muse).toBe("1.3.0");
  });

  it("does not spawn if the execution host has no Muse binary", async () => {
    const host = harness();
    host.locateProvider.mockReturnValue(undefined);
    await expect(host.probeProviderVersion("muse")).resolves.toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "missing binary"])("does not advertise a cached version when %s", condition => {
    const host = harness();
    host.providerCliVersions.muse = "1.3.0";
    if (condition === "disconnected") host.providerConnections = () => ({ muse: false });
    else host.locatedProviders = () => ({ muse: false });
    expect(host.providerStateMessage().providers.find((p: any) => p.id === "muse")).not.toHaveProperty("cliVersion");
  });
});
