import { describe, expect, it } from "vitest";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";

function streamOf(text, splitAt = null) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      if (splitAt == null) controller.enqueue(bytes);
      else {
        controller.enqueue(bytes.subarray(0, splitAt));
        controller.enqueue(bytes.subarray(splitAt));
      }
      controller.close();
    },
  });
}

const wire = (events, separator = "\n\n") => events
  .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`)
  .join(separator) + separator;

describe("Responses SSE to JSON conversion", () => {
  it("returns completed output and usage", async () => {
    const result = await convertResponsesStreamToJson(streamOf(wire([
      { event: "response.created", data: { type: "response.created", response: { id: "resp_1", created_at: 1700000000, status: "in_progress" } } },
      { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } } },
      { event: "response.completed", data: { type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } } },
    ]), 7));

    expect(result).toMatchObject({ id: "resp_1", status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    expect(result.output[0].content[0].text).toBe("ok");
    expect(result.error).toBeNull();
  });

  it.each([
    ["response.failed", { type: "response.failed", response: { status: "failed", error: { message: "upstream failed" } } }, "failed"],
    ["response.done failed", { type: "response.done", response: { status: "failed", error: { message: "done failed" } } }, "failed"],
    ["response.incomplete", { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "incomplete"],
  ])("preserves %s instead of inventing completed", async (event, data, status) => {
    const result = await convertResponsesStreamToJson(streamOf(wire([{ event, data }])));
    expect(result.status).toBe(status);
    expect(result.status).not.toBe("completed");
    if (status === "failed") expect(result.error.message).toMatch(/failed/);
    if (status === "incomplete") expect(result.incomplete_details.reason).toBe("max_output_tokens");
  });

  it.each(["failed", "incomplete", "cancelled"])("does not overwrite %s with a later completed event", async (status) => {
    const result = await convertResponsesStreamToJson(streamOf(wire([
      { event: "response.done", data: { response: { status, error: status === "failed" ? { message: "failed first" } : null } } },
      { event: "response.completed", data: { response: { status: "completed" } } },
    ])));
    expect(result.status).toBe(status);
  });

  it("marks EOF without a terminal event failed", async () => {
    const result = await convertResponsesStreamToJson(streamOf("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n"));
    expect(result.status).toBe("failed");
    expect(result.error.message).toContain("before response.completed");
  });
});
