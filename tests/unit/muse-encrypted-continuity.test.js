/**
 * Muse Spark multi-turn continuity is encrypted-only (Meta Responses,
 * store:false): router must request reasoning.encrypted_content, surface it to
 * Claude clients as the thinking signature / redacted_thinking data, accept it
 * back from Claude history, replay it as a reasoning input item, and tag
 * intermediate assistant text before function_call as phase:"commentary".
 * Native Muse client capture confirms this exact wire shape.
 */
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { initState, translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const MODEL = "muse-spark-1.3";

function claudeHistoryBody() {
  return {
    model: MODEL,
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "You are an agent." }],
    tools: [
      { name: "Read", description: "read file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "read x.txt" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "need to read first", signature: "ENC1" },
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "toolu_01ABC", name: "Read", input: { file_path: "/x.txt" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "file contents" }] },
    ],
  };
}

describe("muse encrypted reasoning continuity", () => {
  it("claude history -> responses replays signature as reasoning item before function_call", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL, claudeHistoryBody(), true, null, "muse", null, [], null, null);
    const reasoning = out.input.find((i) => i.type === "reasoning");
    expect(reasoning).toMatchObject({ encrypted_content: "ENC1" });
    const kinds = out.input.map((i) => i.type);
    expect(kinds.indexOf("reasoning")).toBeLessThan(kinds.indexOf("function_call"));
    const msg = out.input.find((i) => i.type === "message" && i.role === "assistant");
    expect(msg.phase).toBe("commentary");
  });

  it("final assistant text carries no phase", () => {
    const body = claudeHistoryBody();
    body.messages[1].content = body.messages[1].content.filter((b) => b.type !== "tool_use");
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL, body, true, null, "muse", null, [], null, null);
    const msg = out.input.find((i) => i.type === "message" && i.role === "assistant");
    expect(msg).not.toHaveProperty("phase");
  });

  it("reasoning-only assistant turn emits no reasoning item (Meta 400 guard)", () => {
    const body = claudeHistoryBody();
    body.messages[1].content = [{ type: "thinking", thinking: "only thought", signature: "ENC9" }];
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL, body, true, null, "muse", null, [], null, null);
    expect(out.input.some((i) => i.type === "reasoning")).toBe(false);
  });

  it("redacted_thinking data also replays as encrypted_content", () => {
    const body = claudeHistoryBody();
    body.messages[1].content[0] = { type: "redacted_thinking", data: "ENC2" };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL, body, true, null, "muse", null, [], null, null);
    expect(out.input.find((i) => i.type === "reasoning")).toMatchObject({ encrypted_content: "ENC2" });
  });

  it("responses stream -> claude emits signature_delta before thinking stop", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = [
      { type: "response.reasoning_summary_text.delta", item_id: "rs1", delta: "thinking..." },
      { type: "response.output_item.done", item: { id: "rs1", type: "reasoning", encrypted_content: "ENC1", summary: [] } },
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
    ];
    const out = [];
    for (const ev of events) out.push(...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state));
    out.push(...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, null, state));
    const sigIdx = out.findIndex((r) => r?.delta?.type === "signature_delta");
    expect(sigIdx).toBeGreaterThan(-1);
    expect(out[sigIdx].delta.signature).toBe("ENC1");
    expect(out[sigIdx + 1]?.type).toBe("content_block_stop");
    expect(out.at(-1)?.type).toBe("message_stop");
  });

  it("signature without summary becomes redacted_thinking block", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = [
      { type: "response.output_item.done", item: { id: "rs1", type: "reasoning", encrypted_content: "ENC3", summary: [] } },
      { type: "response.output_text.delta", delta: "answer" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
    ];
    const out = [];
    for (const ev of events) out.push(...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state));
    const block = out.find((r) => r?.content_block?.type === "redacted_thinking");
    expect(block?.content_block?.data).toBe("ENC3");
  });

  it("executor adds include only on Responses wire", () => {
    const ex = new DefaultExecutor("muse");
    const responses = ex.transformRequest(MODEL, { input: [] }, true, {});
    expect(responses.include).toEqual(["reasoning.encrypted_content"]);
    const chat = ex.transformRequest(MODEL, { messages: [] }, true, {});
    expect(chat.include).toBeUndefined();
  });

  it("executor sends no x-api-version header (native data plane parity)", () => {
    const ex = new DefaultExecutor("muse");
    const headers = ex.buildHeaders({ accessToken: "LLM|test" }, true, "https://api.meta.ai/v1/responses", MODEL, {});
    expect(headers).not.toHaveProperty("x-api-version");
    expect(headers.Authorization).toBe("Bearer LLM|test");
  });

  it("unknown response.incomplete reason finishes as length, not throw", () => {
    const state = initState(FORMATS.CLAUDE);
    const out = [];
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { id: "r1", status: "incomplete", incomplete_details: { reason: "server_overloaded" }, usage: { input_tokens: 10, output_tokens: 5 } } },
    ];
    for (const ev of events) out.push(...translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, ev, state));
    const delta = out.find((r) => r?.type === "message_delta");
    expect(delta?.delta?.stop_reason).toBe("max_tokens");
  });
});
