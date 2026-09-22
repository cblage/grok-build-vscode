import { describe, expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";

describe("Muse raw notification projection", () => {
  it("appends live text and authoritative suffixes without duplicating or rewriting a prefix", () => {
    const updates: any[] = [], logs: string[] = [];
    const projection = new Projection(u => updates.push(u), m => logs.push(m));
    const revision = (revision: number, text: string) => projection.accept("item/updated", {
      item: { itemId: "answer", kind: "agentMessage", revision, text },
    });
    revision(1, "");
    projection.accept("item/delta", { itemId: "answer", field: "text", delta: "Hello" });
    projection.accept("item/delta", { itemId: "answer", field: "text", delta: " world" });
    revision(2, "Hello world");
    revision(2, "Hello world");
    revision(1, "STALE");
    revision(3, "Hello");
    revision(4, "Changed prefix");
    revision(5, "Hello world!");
    expect(updates.map(u => u.content.text)).toEqual(["Hello", " world", "!"]);
    expect(logs).toEqual(["Muse projection: prefix-changing text revision for item answer"]);
  });

  it("projects tool output snapshots and consumes reminder lifecycle without answer text", () => {
    const updates: any[] = [], logs: string[] = [];
    const p = new Projection(u => updates.push(u), m => logs.push(m));
    p.accept("item/started", { item: { itemId: "tool", callId: "call", kind: "toolCall",
      revision: 1, tool: "bash", args: { command: "example" }, status: "running" } });
    for (const delta of ["one", " two"]) p.accept("item/delta", { itemId: "tool", field: "output", delta });
    p.accept("item/completed", { item: { itemId: "tool", callId: "call", kind: "toolCall",
      revision: 2, tool: "bash", status: "completed", visibleOutput: "one two" } });
    p.accept("item/started", { item: { itemId: "reminder", kind: "reminderChild", revision: 1, text: "hidden" } });
    p.accept("item/delta", { itemId: "reminder", field: "text", delta: "hidden delta" });
    p.accept("item/completed", { item: { itemId: "reminder", kind: "reminderChild", revision: 2, text: "hidden final" } });
    expect(updates.filter(u => u.sessionUpdate === "agent_message_chunk")).toEqual([]);
    expect(updates.filter(u => u.content).map(u => u.content[0].content.text)).toEqual(["one", "one two"]);
    expect(updates.at(-1)).toMatchObject({ toolCallId: "call", status: "completed" });
    expect(logs).toEqual([]);
  });
});
