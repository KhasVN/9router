// Offline regression checks. Node >=22.15; no npm install, credentials or provider calls.
// Run from repo root: node --test tests/commandcode-claude-regression.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

process.env.NODE_ENV = "production";
globalThis.fetch = async () => { throw new Error("Network disabled in offline tests"); };
const root = new URL("../", import.meta.url);
const mock = (source) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/usageDb.js") return mock(`
      export const trackPendingRequest = () => {};
      export const appendRequestLog = async () => {};
      export const saveRequestDetail = async () => {};
      export const saveRequestUsage = async () => {};
    `);
    if (specifier.endsWith("/db/helpers/kvStore.js")) return mock(`
      export const makeKv = () => ({ get: async () => null, getAll: async () => ({}), set: async () => {}, remove: async () => {} });
    `);
    // Unused dependencies pulled in by the translator registry. No converter is mocked.
    if (specifier === "undici") return mock(`export class Agent { constructor() { throw new Error("Network disabled"); } }`);
    if (specifier === "uuid") return mock(`export { randomUUID as v4 } from "node:crypto";`);
    if (specifier.startsWith("@/")) return nextResolve(new URL(`src/${specifier.slice(2)}`, root).href, context);
    if (specifier.startsWith("open-sse/")) return nextResolve(new URL(specifier, root).href, context);
    return nextResolve(specifier, context);
  },
});

const { inspectAndWrapCommandCodeResponse } = await import("../open-sse/executors/commandcode.js");
const { createSSEStream } = await import("../open-sse/utils/stream.js");
const { handleForcedSSEToJson, parseSSEToOpenAIResponse } = await import("../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { translateNonStreamingResponse, handleNonStreamingResponse } = await import("../open-sse/handlers/chatCore/nonStreamingHandler.js");
const encoder = new TextEncoder();
const model = "fixture-model";
const input = { file_path: "café/文.txt" };
const events = [
  { type: "start" },
  { type: "reasoning-delta", text: "Inspect fixture." },
  { type: "text-delta", text: "Reading fixture." },
  { type: "tool-input-start", id: "call_fixture", toolName: "Read" },
  { type: "tool-input-delta", id: "call_fixture", delta: JSON.stringify(input) },
  { type: "tool-call", toolCallId: "call_fixture", toolName: "Read", input },
  { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
  { type: "finish" },
];
const lines = events.map(event => `${JSON.stringify(event)}\n`);
const bytes = encoder.encode(lines.join(""));
const unicodeSplit = bytes.indexOf(0xc3) + 1;
assert(unicodeSplit > 0, "Fixture must split an actual multibyte character");
const layouts = [
  ["one event per chunk", lines],
  ["all events in one chunk", [bytes]],
  ["one byte per chunk", [...bytes].map((_, i) => bytes.subarray(i, i + 1))],
  ["split UTF-8 after peek", [bytes.subarray(0, unicodeSplit), bytes.subarray(unicodeSplit)]],
  ["no final newline", [lines.join("").trimEnd()]],
  ["SSE prefix and CRLF", [events.map(event => `data: ${JSON.stringify(event)}\r\n`).join("")]],
];
function response(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function payloads(sse) {
  return sse.split("\n").filter(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]").map(line => JSON.parse(line.slice(5)));
}
const wrapped = chunks => inspectAndWrapCommandCodeResponse(response(chunks), model);
async function translated(chunks, sourceFormat) {
  const upstream = await wrapped(chunks);
  const transform = createSSEStream({ targetFormat: "commandcode", sourceFormat, provider: "commandcode", model });
  return payloads(await new Response(upstream.body.pipeThrough(transform)).text());
}
function jsonContext(providerResponse, sourceFormat = "claude", targetFormat = "commandcode") {
  return {
    providerResponse, sourceFormat, targetFormat, provider: "commandcode", model,
    body: { model, stream: false, messages: [{ role: "user", content: "Fixture" }] },
    stream: true, requestStartTime: Date.now(), trackDone() {}, appendLog() {},
  };
}
function assertMessage(json, expectedContent) {
  assert.equal(json.type, "message");
  assert.equal(json.role, "assistant");
  assert.equal(json.model, model);
  assert.equal(json.object, undefined);
  assert.equal(json.choices, undefined);
  assert.equal(json.stop_reason, "tool_use");
  assert.deepEqual(json.content, expectedContent);
  assert.deepEqual(json.usage, { input_tokens: 12, output_tokens: 7 });
}
const toolBlock = { type: "tool_use", id: "call_fixture", name: "Read", input };

for (const [name, chunks] of layouts) {
  test(`CommandCode preserves content, tool arguments and terminal events: ${name}`, async () => {
    const chat = payloads(await (await wrapped(chunks)).text());
    assert.equal(chat.map(c => c.choices[0].delta.content || "").join(""), "Reading fixture.");
    assert.equal(chat.map(c => c.choices[0].delta.reasoning_content || "").join(""), "Inspect fixture.");
    assert.equal(chat.map(c => c.choices[0].delta.tool_calls?.[0]?.function.arguments || "").join(""), JSON.stringify(input));
    assert.equal(chat.filter(c => c.choices[0].finish_reason).length, 1);
    assert.equal(chat.at(-1).choices[0].finish_reason, "tool_calls");
    assert.deepEqual(chat.at(-1).usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
    for (const format of ["claude", "openai-responses"]) {
      const output = await translated(chunks, format);
      const terminal = format === "claude" ? "message_stop" : "response.completed";
      assert.equal(output.filter(e => e.type === terminal).length, 1, `${format}: exactly one terminal`);
      const argumentsText = format === "claude"
        ? output.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("")
        : output.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta).join("");
      assert.equal(argumentsText, JSON.stringify(input), `${format}: intact tool arguments`);
    }
  });
}

test("Claude forced Chat SSE fallback shares ordinary JSON conversion and retains thinking", async () => {
  const sse = await (await wrapped([bytes])).text();
  const result = await handleForcedSSEToJson(jsonContext(response([sse])));
  assert.equal(result.success, true);
  assert.equal(result.response.status, 200);
  const json = await result.response.json();
  assertMessage(json, [
    { type: "thinking", thinking: "Inspect fixture." },
    { type: "text", text: "Reading fixture." },
    toolBlock,
  ]);
  assert.deepEqual(json, translateNonStreamingResponse(parseSSEToOpenAIResponse(sse, model), "openai", "claude"));
});

const responsesEvents = [
  { type: "response.created", response: { id: "resp_fixture", created_at: 1700000000 } },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading fixture." }] } },
  { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_fixture", name: "Read", arguments: JSON.stringify(input) } },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } },
];
const responsesWire = list => list.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("Claude forced Responses SSE fallback returns Message with tools and usage", async () => {
  const result = await handleForcedSSEToJson(jsonContext(response([responsesWire(responsesEvents)]), "claude", "openai-responses"));
  assert.equal(result.success, true);
  assert.equal(result.response.status, 200);
  assertMessage(await result.response.json(), [{ type: "text", text: "Reading fixture." }, toolBlock]);
});

test("Chat and Responses clients retain their native JSON format", async () => {
  for (const format of ["openai", "openai-responses"]) {
    const result = await handleForcedSSEToJson(jsonContext(await wrapped([bytes]), format));
    assert.equal(result.success, true);
    const json = await result.response.json();
    if (format === "openai") {
      assert.equal(json.object, "chat.completion");
      assert.equal(json.choices[0].message.tool_calls[0].function.arguments, JSON.stringify(input));
    } else {
      assert.equal(json.object, "response");
      assert.equal(json.output.find(item => item.type === "function_call").arguments, JSON.stringify(input));
    }
  }
});

test("Initial CommandCode errors remain non-2xx for account/combo fallback", async () => {
  const errorEvents = [{ type: "start" }, { type: "error", error: { statusCode: 503, message: "Fixture unavailable" } }];
  const errorLines = errorEvents.map(e => `${JSON.stringify(e)}\n`);
  for (const chunks of [errorLines, [errorLines.join("")], [errorLines.join("").trimEnd()]]) {
    const result = await wrapped(chunks);
    assert.equal(result.status, 503);
    assert.match((await result.json()).error.message, /Fixture unavailable/);
  }
});

test("Ordinary non-streaming handler rejects incomplete SSE and embedded upstream errors", async () => {
  const partial = 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  for (const wire of [partial + "data: [DONE]\n\n", partial + 'data: {"error":{"message":"Fixture upstream failed"}}\n\n']) {
    const ctx = jsonContext(response([wire]), "claude", "openai");
    let successCalls = 0;
    ctx.onRequestSuccess = () => { successCalls++; };
    const result = await handleNonStreamingResponse(ctx);
    assert.equal(result.success, false);
    assert.equal(result.response.status, 502);
    assert((await result.response.json()).error);
    assert.equal(successCalls, 0);
  }
});

for (const [finishReason, stopReason] of [["stop", "end_turn"], ["length", "max_tokens"]]) {
  test(`Claude text-only fallback maps ${finishReason} without inventing tool calls`, async () => {
    const wire = [
      { id: "chatcmpl-text-fixture", model, choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
    const result = await handleForcedSSEToJson(jsonContext(response([wire])));
    assert.equal(result.success, true);
    const json = await result.response.json();
    assert.equal(json.type, "message");
    assert.equal(json.stop_reason, stopReason);
    assert.deepEqual(json.content, [{ type: "text", text: "Hello" }]);
    assert.deepEqual(json.usage, { input_tokens: 12, output_tokens: 7 });
  });
}

test("Peek reader failures propagate instead of returning a consumed response", async () => {
  let pulled = false;
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      if (pulled) controller.error(new Error("Fixture read failure"));
      else { pulled = true; controller.enqueue(encoder.encode(lines[0])); }
    },
  }));
  await assert.rejects(inspectAndWrapCommandCodeResponse(upstream, model), /Fixture read failure/);
});

test("Truncated CommandCode streams never acquire successful Claude/Responses terminal events", async () => {
  const truncated = [lines.slice(0, -2).join("")];
  for (const format of ["claude", "openai-responses"]) {
    const output = await translated(truncated, format);
    assert(!output.some(e => e.type === "message_stop" || e.type === "response.completed"));
  }
});

test("CommandCode error finishReason rejects and never emits fake stopping token message_stop", async () => {
  const errorEvents = [
    { type: "start" },
    { type: "text-delta", text: "Something went wrong upstream" },
    { type: "finish-step", finishReason: "error", error: "upstream failed" },
    { type: "finish" },
  ];
  const errorLines = [errorEvents.map(e => `${JSON.stringify(e)}\n`).join("")];
  for (const format of ["claude", "openai-responses"]) {
    await assert.rejects(async () => {
      const output = await translated(errorLines, format);
      assert(!output.some(e => e.type === "message_stop" || e.type === "response.completed"));
    }, /CommandCode error/);
  }
});

for (const [name, format, upstream] of [
  ["truncated Chat", "commandcode", () => wrapped([lines.slice(0, -2).join("")])],
  ["truncated Responses", "openai-responses", () => response([responsesWire(responsesEvents.slice(0, -1))])],
  ["failed Responses", "openai-responses", () => response([responsesWire([{ type: "response.failed", response: { status: "failed" } }])])],
]) {
  test(`Claude JSON fallback rejects ${name} before reporting success`, async () => {
    const ctx = jsonContext(await upstream(), "claude", format);
    let successCalls = 0;
    ctx.onRequestSuccess = () => { successCalls++; };
    const result = await handleForcedSSEToJson(ctx);
    assert.equal(successCalls, 0, "Incomplete upstream marked successful");
    assert.equal(result.success, false);
    assert.equal(result.response.status, 502);
    assert((await result.response.json()).error);
  });
}
