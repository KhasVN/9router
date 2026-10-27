/**
 * Muse upstream streams that close before any output event are transient
 * (native Muse client retries the POST). DefaultExecutor must re-POST while
 * nothing was forwarded downstream; after output, the stream passes through.
 * Network layer mocked at proxyFetch, same seam as base-executor-retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
beforeEach(() => fetchMock.mockReset());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const enc = new TextEncoder();
function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const LIFECYCLE_ONLY = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n';
const WITH_OUTPUT = LIFECYCLE_ONLY + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';

function args() {
  return {
    model: "muse-spark-1.3",
    body: { model: "muse-spark-1.3", input: [], stream: true },
    stream: true,
    credentials: { accessToken: "LLM|test", runtimeTransport: { baseUrl: "https://api.meta.ai/v1/responses", format: "openai-responses" } },
    log: null,
  };
}

describe("muse executor pre-output EOF retry", () => {
  it("retries EOF-before-output then returns the good stream intact", async () => {
    fetchMock
      .mockImplementationOnce(async () => sseResponse(LIFECYCLE_ONLY))
      .mockImplementationOnce(async () => sseResponse(LIFECYCLE_ONLY))
      .mockImplementationOnce(async () => sseResponse(WITH_OUTPUT));
    const ex = new DefaultExecutor("muse");
    const { response } = await ex.execute(args());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(WITH_OUTPUT);
    expect(enc.encode(WITH_OUTPUT).length).toBeGreaterThan(0);
  }, 30000);

  it("returns 502 after bounded retries when upstream always closes early", async () => {
    fetchMock.mockImplementation(async () => sseResponse(LIFECYCLE_ONLY));
    const ex = new DefaultExecutor("muse");
    const { response } = await ex.execute(args());
    expect(response.status).toBe(502);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  }, 30000);

  it("does not retry once output exists", async () => {
    fetchMock.mockImplementation(async () => sseResponse(WITH_OUTPUT));
    const ex = new DefaultExecutor("muse");
    const { response } = await ex.execute(args());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe(WITH_OUTPUT);
  });

  it("non-muse providers never peek", async () => {
    fetchMock.mockImplementation(async () => sseResponse(LIFECYCLE_ONLY));
    const ex = new DefaultExecutor("some-provider");
    const { response } = await ex.execute({
      model: "m",
      body: { model: "m", messages: [], stream: true },
      stream: true,
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });
});
