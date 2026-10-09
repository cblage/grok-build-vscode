/**
 * Every harness that launches a real host states the person's Connect choice
 * the way the host reads it.
 *
 * #171 made a provider connection a stored choice that nothing infers, and
 * moved it to a new key so old, probe-assigned flags would be ignored. Three
 * harnesses were left behind: two seeded nothing, so the release screens gate
 * and the relay's lifecycle gate both waited forever for a Grok that the host
 * correctly refused to start; the third seeded the OLD key, which the host now
 * deliberately ignores. None of that is visible from the harness itself, which
 * is why the key is pinned here against the one the host actually reads.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const key = /const PROVIDER_CONNECTIONS_KEY = "([^"]+)";/.exec(read("src/sidebar.ts"))?.[1];

describe("harnesses seed the connection key the host reads", () => {
  it("finds the key in the host", () => {
    expect(key).toMatch(/^grok\.providerConnections/);
  });

  it.each([
    "scripts/desk-screens-check.mjs",
    "scripts/lifecycle-host.mjs",
    "test/desktop/provider-user-flows.test.ts",
  ])("%s", file => {
    const source = read(file);
    expect(source).toContain(`"${key}"`);
    // The pre-#171 key, as a seed, is exactly the drift this exists to catch.
    expect(source).not.toMatch(/"grok\.providerConnections"\s*:/);
  });
});
