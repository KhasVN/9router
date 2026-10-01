import { describe, expect, it } from "vitest";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";

const partialChatChunk = {
  id: "chatcmpl_partial",
  choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
};

function completeChatChunk() {
  return {
    id: "chatcmpl_done",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

describe("Chat-to-Responses EOF handling", () => {
  it("rejects translator flush when upstream ends without finish_reason", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const chunks = openaiToOpenAIResponsesResponse(partialChatChunk, state);
    expect(chunks.some(({ event }) => event === "response.output_text.delta")).toBe(true);
    expect(() => openaiToOpenAIResponsesResponse(null, state))
      .toThrow("stream closed before upstream finish_reason");
  });

  it("accepts explicit upstream finish before EOF", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    openaiToOpenAIResponsesResponse(partialChatChunk, state);
    const terminal = openaiToOpenAIResponsesResponse(completeChatChunk(), state);
    expect(terminal.some(({ event }) => event === "response.completed")).toBe(true);
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
  });

  it.each([["length", "max_output_tokens"], ["content_filter", "content_filter"]])("preserves %s in both streaming translators", async (finish, reason) => {
    const chunk = { ...partialChatChunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = openaiToOpenAIResponsesResponse(chunk, state);
    expect(events.find(e => e.event === "response.incomplete")?.data.response)
      .toMatchObject({ status: "incomplete", incomplete_details: { reason } });
    expect(events.some(e => e.event === "response.completed")).toBe(false);
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
    const source = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`).body;
    const wire = await new Response(source.pipeThrough(createResponsesApiTransformStream())).text();
    expect(wire).toContain('"status":"incomplete"');
    expect(wire).not.toContain("response.completed");
  });

  it("rejects the standalone Responses transformer on truncated Chat SSE", async () => {
    const input = `data: ${JSON.stringify(partialChatChunk)}\n\ndata: [DONE]\n\n`;
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const output = source.pipeThrough(createResponsesApiTransformStream());
    const reader = output.getReader();
    await expect((async () => {
      while (!(await reader.read()).done) {}
    })()).rejects.toThrow("stream closed before upstream finish_reason");
  });
});
