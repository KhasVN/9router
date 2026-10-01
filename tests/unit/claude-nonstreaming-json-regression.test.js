import { describe, it, expect } from "vitest";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Claude non-streaming response format regression", () => {
  it("converts OpenAI-format output to Anthropic Message for Claude clients", () => {
    const openaiBody = {
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    };
    const res = translateNonStreamingResponse(openaiBody, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(res.type).toBe("message");
    expect(res.role).toBe("assistant");
    expect(res.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("converts Gemini non-streaming through OpenAI into Claude message", () => {
    const geminiBody = {
      candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    };
    const res = translateNonStreamingResponse(geminiBody, FORMATS.CLAUDE, FORMATS.GEMINI);
    expect(res.type).toBe("message");
    expect(res.content?.[0]?.text).toBe("pong");
  });

  it("preserves tool calls when converting forced SSE to Claude JSON", () => {
    const openaiBody = {
      id: "chatcmpl-tool",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"test.txt"}' } }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 20, completion_tokens: 15 }
    };
    const res = translateNonStreamingResponse(openaiBody, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(res.type).toBe("message");
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toEqual([
      { type: "tool_use", id: "call_1", name: "read", input: { path: "test.txt" } }
    ]);
  });
});
