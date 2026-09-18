// Offline integration checks. Node >=22.15; no npm install, credentials or provider calls.
// node --test tests/commandcode-upstream-regression.test.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { test } from "node:test";

process.env.NODE_ENV = "production";
process.env.COMMAND_CODE_API_BASE_URL = "https://api.commandcode.ai";
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
let fixtureFetch = async () => { throw new Error("Unexpected network request in offline check"); };
globalThis.fetch = (...args) => fixtureFetch(...args);
const root = new URL("../", import.meta.url);
const mock = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/usageDb.js") return mock(`export const trackPendingRequest=()=>{};export const appendRequestLog=async()=>{};export const saveRequestDetail=async()=>{};export const saveRequestUsage=async()=>{};`);
    if (specifier.endsWith("/db/helpers/kvStore.js")) return mock(`export const makeKv=()=>({get:async()=>null,getAll:async()=>({}),set:async()=>{},remove:async()=>{}});`);
    // Only storage and transport dependencies are mocked. Executors/translators are real.
    if (specifier === "undici") return mock(`export class Agent { close(){return Promise.resolve()} } export class ProxyAgent { constructor(){throw new Error("Proxy disabled in offline check")} }`);
    if (specifier === "node:dns/promises" && context.parentURL.endsWith("/concerns/image.js")) return mock(`export async function lookup(host){if(host!=="image.example.invalid")throw new Error("Unexpected DNS");return [{address:"203.0.113.1",family:4}]}`);
    if (specifier === "uuid") return mock(`export { randomUUID as v4 } from "node:crypto";`);
    if (specifier.startsWith("@/")) {
      let url = new URL(`src/${specifier.slice(2)}`, root);
      if (!existsSync(url) && existsSync(new URL(url.href + ".js"))) url = new URL(url.href + ".js");
      return nextResolve(url.href, context);
    }
    if (specifier.startsWith("open-sse/")) return nextResolve(new URL(specifier, root).href, context);
    return nextResolve(specifier, context);
  },
});
const { translateRequest } = await import("../open-sse/translator/index.js");
const { prefetchRemoteImages } = await import("../open-sse/translator/concerns/prefetch.js");
const { getCapabilitiesForModel } = await import("../open-sse/providers/capabilities.js");
const { CommandCodeExecutor, inspectAndWrapCommandCodeResponse } = await import("../open-sse/executors/commandcode.js");
const { getUsageForProvider } = await import("../open-sse/services/usage.js");
const { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } = await import("../src/shared/constants/providers.js");
const { parseQuotaData } = await import("../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
const encoder = new TextEncoder();
const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
const dataUri = `data:image/png;base64,${png.toString("base64")}`;
const ndjson = (events, packed = false) => new Response(new ReadableStream({
  start(controller) {
    const lines = events.map(event => JSON.stringify(event) + "\n");
    for (const chunk of packed ? [lines.join("")] : lines) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
}), { headers: { "Content-Type": "application/x-ndjson" } });
const errorEvent = statusCode => ({ type: "error", error: { statusCode, message: "Fixture upstream unavailable" } });
const successEvents = [{ type: "text-delta", text: "Recovered" }, { type: "finish", finishReason: "stop" }];
const options = () => ({ model: "meta/muse-spark-1.3-contributor", body: { params: { messages: [], stream: true } }, stream: true, credentials: { apiKey: "user_fixture_not_real" } });

for (const source of ["openai", "claude"]) {
  test(`${source} images and all advertised effort levels survive real translation`, () => {
    for (const model of ["meta/muse-spark-1.3-contributor", "deepseek/deepseek-v4.1-flash"]) {
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        const body = {
          messages: [{ role: "user", content: [{ type: "text", text: "Describe fixture" }, source === "openai"
            ? { type: "image_url", image_url: { url: dataUri } }
            : { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }],
          ...(source === "openai" ? { reasoning_effort: effort } : { output_config: { effort } }),
        };
        const result = translateRequest(source, "commandcode", model, body, true, {}, "commandcode");
        assert.equal(result.params.reasoning_effort, effort);
        assert.equal(result.reasoning_effort, undefined);
        assert.deepEqual(result.params.messages[0].content.find(block => block.type === "image"), {
          type: "image", image: dataUri, mimeType: "image/png", mediaType: "image/png",
        });
        assert.equal(getCapabilitiesForModel("commandcode", model).vision, true);
      }
    }
  });
  test(`${source} remote images enter prefetch and survive translation`, async () => {
    let calls = 0;
    fixtureFetch = async (url, opts) => {
      assert.equal(String(url), "https://image.example.invalid/test.png");
      assert.equal(opts.redirect, "manual");
      calls++;
      return new Response(png);
    };
    const body = { messages: [{ role: "user", content: [source === "openai"
      ? { type: "image_url", image_url: { url: "https://image.example.invalid/test.png" } }
      : { type: "image", source: { type: "url", url: "https://image.example.invalid/test.png" } }] }] };
    assert.equal(await prefetchRemoteImages(body, source, "commandcode"), 1);
    assert.equal(calls, 1);
    const result = translateRequest(source, "commandcode", "meta/muse-spark-1.3-contributor", body, true, {}, "commandcode");
    assert.equal(result.params.messages[0].content[0].image, dataUri);
  });
}
for (const status of [502, 503, 504]) {
  test(`actual executor retries initial embedded ${status} then succeeds`, async () => {
    let calls = 0;
    fixtureFetch = async (url, opts) => {
      assert.equal(String(url), "https://api.commandcode.ai/alpha/generate");
      assert.equal(opts.headers.Authorization, "Bearer user_fixture_not_real");
      calls++;
      return ndjson(calls === 1 ? [errorEvent(status)] : successEvents);
    };
    const result = await new CommandCodeExecutor().execute(options());
    assert.equal(calls, 2);
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /Recovered/);
  });
}
test("actual executor limits retries and returns final error", async () => {
  let calls = 0;
  fixtureFetch = async () => { calls++; return ndjson([errorEvent(503)]); };
  const result = await new CommandCodeExecutor().execute(options());
  assert.equal(calls, 3);
  assert.equal(result.response.status, 503);
});
test("auth and rate-limit stream errors do not get these transient retries", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    fixtureFetch = async () => { calls++; return ndjson([errorEvent(status)]); };
    const result = await new CommandCodeExecutor().execute(options());
    assert.equal(calls, 1);
    assert.equal(result.response.status, status);
  }
});
test("separate-chunk midstream error aborts instead of fake stop", async () => {
  const result = await inspectAndWrapCommandCodeResponse(ndjson([successEvents[0], errorEvent(503)]), "fixture-model");
  await assert.rejects(result.text(), /Fixture upstream unavailable/);
});
test("packed-chunk midstream error must not disappear", async () => {
  const result = await inspectAndWrapCommandCodeResponse(ndjson([successEvents[0], errorEvent(503)], true), "fixture-model");
  await assert.rejects(result.text(), /Fixture upstream unavailable/);
});
test("quota dispatch reads billing fixtures and feeds dashboard rows", async () => {
  assert(USAGE_SUPPORTED_PROVIDERS.includes("commandcode"));
  assert(USAGE_APIKEY_PROVIDERS.includes("commandcode"));
  const requests = [];
  fixtureFetch = async (url, opts) => {
    assert.equal(opts.headers.Authorization, "Bearer user_fixture_not_real");
    const u = new URL(url);
    assert.equal(u.origin, "https://api.commandcode.ai");
    requests.push(u.pathname);
    let body;
    if (u.pathname === "/alpha/whoami") {
      assert.equal(u.searchParams.get("limits"), "1");
      body = { org: { id: "fixture-org" } };
    } else {
      assert.equal(u.searchParams.get("orgId"), "fixture-org");
      if (u.pathname === "/alpha/billing/credits") body = {
        credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
        windowLimits: { fiveHour: { used: 2, cap: 10 }, weekly: { used: 20, cap: 70 } },
      };
      else if (u.pathname === "/alpha/billing/subscriptions") body = { data: { planId: "individual-goat", currentPeriodEnd: "2026-10-01T00:00:00Z" } };
      else throw new Error("Unexpected fixture route");
    }
    return Response.json(body);
  };
  const result = await getUsageForProvider({ provider: "commandcode", apiKey: "user_fixture_not_real" });
  assert.equal(requests.length, 3);
  assert.equal(result.plan, "GOAT");
  assert.equal(result.quotas.Credits.remaining, 14);
  assert.equal(result.quotas.Credits.used, 56);
  assert.equal(result.quotas["Session (5h)"].used, 2);
  assert.equal(result.quotas.Weekly.total, 70);
  assert.equal(parseQuotaData("commandcode", result).length, 3);
});
test("quota rejects missing keys and reports auth failure", async () => {
  let calls = 0;
  fixtureFetch = async () => { calls++; return Response.json({}, { status: 401 }); };
  assert.match((await getUsageForProvider({ provider: "commandcode" })).message, /key/i);
  assert.equal(calls, 0);
  assert.match((await getUsageForProvider({ provider: "commandcode", apiKey: "fixture" })).message, /authentication failed/i);
  assert.equal(calls, 1);
});
