import { describe, it, expect } from "vitest";
import { commandCodeToOpenAIResponse } from "../../open-sse/translator/response/commandcode-to-openai.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("Fake Stop Fix Verifications", () => {
  it("rejects zero-content finish from commandcode upstream by throwing an error instead of fabricating a stop chunk", () => {
    const state = {};
    commandCodeToOpenAIResponse(JSON.stringify({ type: "finish-step", finishReason: "length" }), state);
    expect(() => {
      commandCodeToOpenAIResponse(JSON.stringify({ type: "finish", finishReason: "length" }), state);
    }).toThrow(/upstream returned empty generation with finishReason length/);
  });

  it("does not emit tool_use stop_reason when tool_calls finish arrives with 0 tool blocks", () => {
    const state = { messageStartSent: true, toolCalls: new Map(), nextBlockIndex: 0 };
    const chunk = {
      id: "chatcmpl-test",
      choices: [{
        finish_reason: "tool_calls",
        delta: {}
      }]
    };
    const results = openaiToClaudeResponse(chunk, state);
    const messageDelta = results.find(r => r.type === "message_delta");
    expect(messageDelta.delta.stop_reason).toBe("end_turn");
  });
});

describe("Fake Stop Follow-up Fixes", () => {
  it("assigns fallback id to tool-call without toolCallId instead of undefined key", async () => {
    const { commandCodeToOpenAIResponse: fn } = await import("../../open-sse/translator/response/commandcode-to-openai.js");
    const state = {};
    const out1 = fn(JSON.stringify({ type: "tool-call", toolName: "Read", input: { path: "/x" } }), state);
    const tc1 = out1[0].choices[0].delta.tool_calls[0];
    expect(tc1.id).toBeDefined();
    expect(tc1.id).not.toBe("undefined");
    // second missing-id tool-call must NOT be dropped as dup-skip
    const out2 = fn(JSON.stringify({ type: "tool-call", toolName: "Bash", input: { cmd: "ls" } }), state);
    expect(out2).not.toBeNull();
    expect(out2.length).toBe(1);
  });
});
