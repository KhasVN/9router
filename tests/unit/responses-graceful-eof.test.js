import { describe, it, expect } from "vitest";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { Readable } from "stream";

describe("Responses graceful EOF handling", () => {
  describe("Translator: openaiResponsesToOpenAIResponse", () => {
    it("completes when content delivered and no partial tools", () => {
      const state = {
        chatId: "chatcmpl-test",
        created: 1700000000,
        started: true,
        msgTextBuf: { 0: "Hello world" },
        msgItemAdded: { 0: true },
        msgItemDone: { 0: true },
        completedOutputItems: new Map([[0, { type: "message", content: [{ type: "output_text", text: "Hello world" }], role: "assistant" }]]),
        funcCallIds: {},
        funcItemDone: {},
        finishReasonSent: false,
        responsesTerminalSeen: false
      };

      const result = openaiResponsesToOpenAIResponse(null, state);

      expect(state.finishReasonSent).toBe(true);
      expect(state.responsesTerminalSeen).toBe(true);
      expect(result).toBeDefined();
      expect(result.choices[0].finish_reason).toBe("stop");
    });

    it("fails on empty generation EOF", () => {
      const state = {
        chatId: "chatcmpl-test",
        created: 1700000000,
        started: true,
        msgTextBuf: {},
        completedOutputItems: new Map(),
        funcCallIds: {},
        funcItemDone: {},
        finishReasonSent: false,
        responsesTerminalSeen: false
      };

      expect(() => openaiResponsesToOpenAIResponse(null, state))
        .toThrow(/stream closed before response.completed/);
    });

    it("fails on mid-tool-call EOF", () => {
      const state = {
        chatId: "chatcmpl-test",
        created: 1700000000,
        started: true,
        msgTextBuf: {},
        completedOutputItems: new Map(),
        funcCallIds: { 0: "call_abc123" },
        funcItemDone: { 0: false }, // tool not finished
        finishReasonSent: false,
        responsesTerminalSeen: false
      };

      expect(() => openaiResponsesToOpenAIResponse(null, state))
        .toThrow(/stream closed before response.completed/);
    });

    it("completes when text buffered but not yet closed", () => {
      const state = {
        chatId: "chatcmpl-test",
        created: 1700000000,
        started: true,
        msgTextBuf: { 0: "Partial response" },
        msgItemAdded: { 0: true },
        msgItemDone: {},
        completedOutputItems: new Map(),
        funcCallIds: {},
        funcItemDone: {},
        finishReasonSent: false,
        responsesTerminalSeen: false
      };

      const result = openaiResponsesToOpenAIResponse(null, state);

      expect(state.finishReasonSent).toBe(true);
      expect(result.choices[0].finish_reason).toBe("stop");
    });

    it("returns null when finishReasonSent already true", () => {
      const state = {
        finishReasonSent: true,
        msgTextBuf: { 0: "content" }
      };

      const result = openaiResponsesToOpenAIResponse(null, state);
      expect(result).toBeNull();
    });
  });

  describe("StreamToJsonConverter: convertResponsesStreamToJson", () => {
    const streamOf = (text) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        }
      });
      return stream;
    };

    const wire = (events) => events
      .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");

    it("completes when output_item.done delivered but no terminal event", async () => {
      const result = await convertResponsesStreamToJson(streamOf(wire([
        { event: "response.created", data: { type: "response.created", response: { id: "resp_1", created_at: 1700000000, status: "in_progress" } } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } } }
      ])));

      expect(result.status).toBe("completed");
      expect(result.output[0].content[0].text).toBe("done");
      expect(result.error).toBeNull();
    });

    it("fails on EOF without items or terminal event", async () => {
      const result = await convertResponsesStreamToJson(streamOf(wire([
        { event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress" } } }
      ])));

      expect(result.status).toBe("failed");
      expect(result.error.message).toContain("before response.completed");
    });

    it("preserves explicit failed status over graceful completion", async () => {
      const result = await convertResponsesStreamToJson(streamOf(wire([
        { event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress" } } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "ok" }] } } },
        { event: "response.failed", data: { type: "response.failed", response: { status: "failed", error: { message: "explicit error" } } } }
      ])));

      expect(result.status).toBe("failed");
      expect(result.error.message).toBe("explicit error");
    });

    it("completes with multiple items delivered", async () => {
      const result = await convertResponsesStreamToJson(streamOf(wire([
        { event: "response.created", data: { type: "response.created", response: { id: "resp_1", status: "in_progress" } } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "first" }] } } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_123", name: "get_weather", arguments: "{}" } } }
      ])));

      expect(result.status).toBe("completed");
      expect(result.output).toHaveLength(2);
      expect(result.output[0].content[0].text).toBe("first");
      expect(result.output[1].type).toBe("function_call");
    });
  });
});
