import { describe, expect, it } from "vitest";
import { createSSEHeartbeatStream } from "../../open-sse/utils/streamHandler.js";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe("SSE heartbeat wrapper", () => {
  it("does not insert heartbeats inside a split SSE event", async () => {
    let controller;
    const source = new ReadableStream({ start(c) { controller = c; } });
    const reader = createSSEHeartbeatStream(source, 10).getReader();
    const encoder = new TextEncoder();
    await reader.read();
    controller.enqueue(encoder.encode('data: {"text":"'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"text":"');
    const pending = reader.read();
    await sleep(30);
    controller.enqueue(encoder.encode('ok"}\r\n\r\n'));
    expect(new TextDecoder().decode((await pending).value)).toBe('ok"}\r\n\r\n');
    await reader.cancel();
  });

  it("keeps idle downstream connections alive without completing the stream", async () => {
    let cancelled = false;
    const source = new ReadableStream({
      cancel() { cancelled = true; },
    });
    const reader = createSSEHeartbeatStream(source, 10).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(": keepalive");
    await sleep(20);
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain(": keepalive");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
