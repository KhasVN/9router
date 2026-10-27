import { describe, it, expect } from "vitest";
import { ensureReasoningSummary } from "../../open-sse/handlers/chatCore/continuity.js";

describe("ensureReasoningSummary", () => {
  it("adds summary:[] to reasoning items missing it, keeps existing", () => {
    const body = { input: [
      { type: "reasoning", id: "rs_1", encrypted_content: "E" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "t" }] },
      { type: "message", role: "user", content: [] },
    ] };
    ensureReasoningSummary(body);
    expect(body.input[0].summary).toEqual([]);
    expect(body.input[1].summary).toHaveLength(1);
    expect(body.input[2]).not.toHaveProperty("summary");
  });
  it("ignores bodies without input[]", () => {
    expect(ensureReasoningSummary({ messages: [] })).toEqual({ messages: [] });
  });
});
