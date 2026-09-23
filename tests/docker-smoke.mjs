// Real production-image check. Node >=22 + Docker; no provider credentials or paid calls.
// node tests/docker-smoke.mjs <image>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const png = Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64");
const input = { file_path: "café/文.txt" };
const tool = { id: "call_fixture", name: "Read", arguments: JSON.stringify(input) };
const mode = process.argv[2];

if (mode === "fixture") {
  const seen = [];
  createServer(async (req, res) => {
    if (req.url === "/seen") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(seen));
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const target = req.headers["x-relay-target"];
      const path = req.headers["x-relay-path"];
      assert(["https://api.commandcode.ai", "https://chatgpt.com", "https://opencode.ai"].includes(target));
      assert(["/alpha/generate", "/backend-api/codex/responses", "/zen/go/v1/responses", "/zen/v1/responses"].includes(path));
      const command = target.includes("commandcode");
      assert.equal(command ? body.params.stream : body.stream, true);
      const model = command ? body.params.model : body.model;
      if (model === "fixture-vision") {
        assert.equal(body.params.reasoning_effort, "high");
        const image = body.params.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === "image");
        assert.equal(image?.image, `data:image/png;base64,${png}`);
      }
      const truncated = req.url === "/truncated";
      const failed = req.url === "/failed";
      const midstreamError = req.url === "/error";
      const retry = req.url === "/retry" && !seen.some(r => r.model === model);
      seen.push({ target, path, model, truncated, failed });
      const error = { type: "error", error: { statusCode: 503, message: "Fixture upstream failure" } };
      const ndjson = retry ? [error] : [
        { type: "start" },
        { type: "reasoning-delta", text: "Inspect fixture." },
        { type: "text-delta", text: "Reading fixture." },
        { type: "tool-input-start", id: tool.id, toolName: tool.name },
        { type: "tool-input-delta", id: tool.id, delta: tool.arguments },
        { type: "tool-call", toolCallId: tool.id, toolName: tool.name, input },
        ...(midstreamError ? [error] : !truncated ? [
          { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
          { type: "finish" },
        ] : []),
      ];
      const output = [
        { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Reading fixture.", annotations: [] }] },
        { type: "function_call", id: "fc_fixture", call_id: tool.id, name: tool.name, arguments: tool.arguments, status: "completed" },
      ];
      const responses = failed
        ? [{ type: "response.failed", response: { status: "failed", error: { message: "Fixture failure" } } }]
        : [
          { type: "response.created", response: { id: "resp_fixture", model, status: "in_progress", created_at: 1700000000 } },
          ...output.flatMap((item, output_index) => [
            { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
            item.type === "function_call"
              ? { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments }
              : { type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: item.content[0].text },
            { type: "response.output_item.done", output_index, item },
          ]),
          ...(midstreamError ? [error] : !truncated ? [{ type: "response.completed", response: { id: "resp_fixture", model, status: "completed", output, usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } }] : []),
        ];
      res.setHeader("Content-Type", "text/event-stream");
      if (req.url === "/idle") {
        assert.equal(body.model, "gpt-6-astra");
        assert.equal(body.reasoning.effort, "max");
        res.flushHeaders();
        await sleep(130000);
      }
      // One write intentionally packs all events into the executor's first read.
      res.end(command
        ? ndjson.map(event => JSON.stringify(event)).join("\n") + "\n"
        : responses.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }).listen(8080, "0.0.0.0");
} else if (mode === "client" || mode === "persist") {
  const base = "http://gateway:20128";
  let ready = false;
  for (let n = 0; n < 90; n++) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).ok) { ready = true; break; }
    } catch { /* wait for production entrypoint */ }
    await sleep(1000);
  }
  assert(ready, "Gateway did not become ready");
  assert.equal((await fetch(`${base}/api/settings`)).status, 401, "Dashboard must require login");
  assert.equal((await fetch(`${base}/v1/models`)).status, 401, "Remote API must require key");
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.SMOKE_PASSWORD }),
  });
  assert.equal(login.status, 200, "Dashboard login failed");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie?.startsWith("auth_token="), "Session cookie missing");
  async function admin(path, body, method = "POST") {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  }
  if (mode === "persist") {
    const { combos } = await admin("/api/combos", undefined, "GET");
    assert(combos.some(c => c.name === "claude-haiku-4-5-20251001"), "Combo lost after container replacement");
    const { connections } = await admin("/api/providers", undefined, "GET");
    assert(connections.some(c => c.provider === "commandcode"), "Provider lost after container replacement");
    console.log("PASS persistence after container replacement");
  } else {
    await admin("/api/settings", { rtkEnabled: false, pxpipeEnabled: false, requireLogin: true, requireApiKey: true }, "PATCH");
    const key = (await admin("/api/keys", { name: "isolated-smoke" })).key;
    assert(key);
    const pool = (await admin("/api/proxy-pools", {
      name: "isolated-fixture", type: "vercel", proxyUrl: "http://fixture:8080/ok", strictProxy: true,
    })).proxyPool;
    const cmc = (await admin("/api/providers", {
      provider: "commandcode", apiKey: "user_fixture_not_real", name: "fixture", proxyPoolId: pool.id,
    })).connection;
    const ocg = (await admin("/api/providers", {
      provider: "opencode-go", apiKey: "fixture-not-real", name: "fixture", proxyPoolId: pool.id,
    })).connection;
    await admin("/api/settings", { providerStrategies: { opencode: { proxyPoolId: pool.id } } }, "PATCH");
    const imported = await admin("/api/oauth/codex/bulk-import", [{
      name: "fixture", email: "fixture@example.invalid", accessToken: "fixture-not-real",
      expiresAt: new Date(Date.now() + 864000000).toISOString(),
      providerSpecificData: { proxyPoolId: pool.id, chatgptAccountId: "fixture", chatgptPlanType: "plus" },
    }]);
    assert.equal(imported.success, 1, "Fixture Codex import failed");
    const codex = { id: imported.results[0].id };
    const alias = "claude-haiku-4-5-20251001";
    await admin("/api/combos", { name: alias, models: ["cmc/fixture-model"] });
    const properties = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
    async function invoke(path, model, stream, expected = 200, extra = {}, expectStreamFailure = false) {
      const responses = path.endsWith("responses");
      const body = responses
        ? { model, stream, input: [{ role: "user", content: "Read fixture" }], tools: [{ type: "function", name: "Read", parameters: properties }] }
        : { model, stream, max_tokens: 128, messages: [{ role: "user", content: "Read fixture" }], tools: [{ name: "Read", input_schema: properties }] };
      const idle = model === "cx/gpt-6-astra";
      const started = Date.now();
      const response = await fetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ ...body, ...extra }), signal: AbortSignal.timeout(idle ? 150000 : 30000),
      });
      let wire = "";
      if (idle) {
        const decoder = new TextDecoder();
        let last = started;
        let reads = 0;
        for await (const chunk of response.body) {
          const now = Date.now();
          assert(now - last < (reads === 0 ? 5000 : 25000), "Downstream stalled despite heartbeat");
          last = now;
          reads++;
          wire += decoder.decode(chunk, { stream: true });
        }
        wire += decoder.decode();
        assert(Date.now() - started >= 130000, "Idle fixture ended early");
        assert(wire.split(": keepalive").length >= 9, "Missing periodic heartbeat comments");
        assert.match(response.headers.get("cache-control"), /no-transform/);
        console.log(`PASS ${path} Astra max effort: 130s upstream silence with downstream heartbeat`);
      } else {
        wire = await response.text();
      }
      assert.equal(response.status, expected, `${path} ${model}: ${wire.slice(0,500)}`);
      if (expected !== 200) {
        assert.match(JSON.parse(wire).error.message, model.includes("fixture-failed")
          ? /\[502\].*Fixture failure/
          : /Upstream (SSE stream ended before a finish reason|Responses stream did not complete successfully)|Failed to convert streaming response to JSON/);
        return;
      }
      if (stream) {
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const events = wire.split(/\r?\n/).filter(l => l.startsWith("data:") && l.slice(5).trim() !== "[DONE]").map(l => JSON.parse(l.slice(5)));
        if (expectStreamFailure || model.includes("fixture-error")) {
          assert(events.some(e => e.error || e.type === "response.failed"), "Upstream failure disappeared");
          assert(!events.some(e => e.type === "message_stop" || e.type === "response.completed"), "Upstream error became a successful turn");
          console.log(`PASS ${path} rejects packed midstream error`);
          return;
        }
        assert.equal(events.filter(e => e.type === (responses ? "response.completed" : "message_stop")).length, 1);
        const args = responses
          ? events.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta).join("")
          : events.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("");
        assert.deepEqual(JSON.parse(args), input);
      } else {
        assert.match(response.headers.get("content-type"), /application\/json/);
        const json = JSON.parse(wire);
        if (responses) {
          assert.equal(json.object, "response");
          assert.equal(json.status, "completed");
          assert.deepEqual(JSON.parse(json.output.find(i => i.type === "function_call").arguments), input);
        } else {
          assert.equal(json.type, "message");
          assert.equal(json.stop_reason, "tool_use");
          assert.deepEqual(json.content.find(b => b.type === "tool_use").input, input);
          assert.equal(json.choices, undefined);
        }
        assert.equal(json.usage.input_tokens, 12);
        assert.equal(json.usage.output_tokens, 7);
      }
      console.log(`PASS ${path} ${model} stream=${stream}`);
    }
    for (const path of ["/v1/messages", "/v1/v1/messages", "/v1/responses"]) {
      for (const stream of [true, false]) await invoke(path, alias, stream);
    }
    await invoke("/v1/messages", "cx/fixture-model", false);
    await invoke("/v1/responses", "cx/fixture-model", false);
    await invoke("/v1/messages", "cmc/fixture-vision", false, 200, {
      output_config: { effort: "high" },
      messages: [{ role: "user", content: [{ type: "text", text: "Describe fixture" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }],
    });
    for (const route of ["retry", "error"]) {
      const routePool = (await admin("/api/proxy-pools", { name: route, type: "vercel", proxyUrl: `http://fixture:8080/${route}` })).proxyPool;
      await admin(`/api/providers/${cmc.id}`, { proxyPoolId: routePool.id }, "PUT");
      if (route === "retry") await invoke("/v1/messages", "cmc/fixture-retry", false);
      else for (const path of ["/v1/messages", "/v1/responses"]) await invoke(path, "cmc/fixture-error", true);
    }
    for (const [connection, provider, route] of [[cmc, "cmc", "error"], [cmc, "cmc", "truncated"], [codex, "cx", "truncated"], [codex, "cx", "failed"]]) {
      const badPool = (await admin("/api/proxy-pools", { name: route, type: "vercel", proxyUrl: `http://fixture:8080/${route}` })).proxyPool;
      await admin(`/api/providers/${connection.id}`, { proxyPoolId: badPool.id }, "PUT");
      // chatCore rejects with 502; account exhaustion exposes 503 at the HTTP boundary.
      await invoke("/v1/messages", `${provider}/fixture-${route}-json`, false, 503);
      console.log(`PASS rejects ${provider} ${route} upstream`);
    }
    const museModels = ["ocg/muse-spark-1.3-contributor", "oc/muse-spark-1.3-contributor-free"];
    for (const model of museModels) {
      for (const path of ["/v1/messages", "/v1/responses"]) {
        for (const stream of [true, false]) await invoke(path, model, stream);
      }
    }
    for (const route of ["error", "truncated", "failed"]) {
      const badPool = (await admin("/api/proxy-pools", { name: `muse-${route}`, type: "vercel", proxyUrl: `http://fixture:8080/${route}` })).proxyPool;
      await admin(`/api/providers/${ocg.id}`, { proxyPoolId: badPool.id }, "PUT");
      await admin("/api/settings", { providerStrategies: { opencode: { proxyPoolId: badPool.id } } }, "PATCH");
      for (const model of museModels) {
        for (const path of ["/v1/messages", "/v1/responses"]) await invoke(path, model, true, 200, {}, true);
      }
    }
    const idlePool = (await admin("/api/proxy-pools", { name: "astra-idle", type: "vercel", proxyUrl: "http://fixture:8080/idle" })).proxyPool;
    await admin(`/api/providers/${codex.id}`, { proxyPoolId: idlePool.id }, "PUT");
    await Promise.all([
      invoke("/v1/messages", "cx/gpt-6-astra", true, 200, { output_config: { effort: "max" } }),
      invoke("/v1/responses", "cx/gpt-6-astra", true, 200, { reasoning: { effort: "max" } }),
    ]);
    const seen = await (await fetch("http://fixture:8080/seen")).json();
    assert.equal(seen.filter(r => r.model === "fixture-retry").length, 2, "Transient failure must retry once");
    assert(seen.some(r => r.model === "fixture-vision"), "Image and effort did not reach upstream");
    assert(seen.length >= 11, "Requests did not reach actual fixture upstream");
    assert(seen.some(r => r.target === "https://api.commandcode.ai"));
    assert(seen.some(r => r.target === "https://chatgpt.com"));
    console.log("PASS real HTTP routing, auth, native protocols, tool arguments and error handling");
  }
} else {
  assert(mode && !mode.startsWith("-"), "Usage: node tests/docker-smoke.mjs <image>");
  const image = mode;
  const name = `9router-smoke-${randomUUID().slice(0,8)}`;
  const fixture = `${name}-fixture`;
  const gateway = `${name}-gateway`;
  const volume = `${name}-data`;
  const mount = `type=bind,src=${fileURLToPath(import.meta.url)},dst=/smoke.mjs,readonly`;
  const env = { ...process.env, SMOKE_PASSWORD: randomUUID(), INITIAL_PASSWORD: "", MSYS_NO_PATHCONV: "1" };
  env.INITIAL_PASSWORD = env.SMOKE_PASSWORD;
  const docker = (...args) => execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000 });
  const created = [];
  function startGateway() {
    docker("run", "-d", "--name", gateway, "--network", name, "--network-alias", "gateway", "--mount", `type=volume,src=${volume},dst=/app/data`, "-e", "INITIAL_PASSWORD", image);
  }
  try {
    docker("image", "inspect", image);
    docker("network", "create", "--internal", name); created.push(["network", "rm", name]);
    docker("volume", "create", volume); created.push(["volume", "rm", volume]);
    docker("run", "-d", "--name", fixture, "--network", name, "--network-alias", "fixture", "--mount", mount, "--entrypoint", "node", image, "/smoke.mjs", "fixture");
    created.push(["rm", "-f", fixture]);
    startGateway(); created.push(["rm", "-f", gateway]);
    for (const phase of ["client", "persist"]) {
      if (phase === "persist") { docker("rm", "-f", gateway); startGateway(); }
      process.stdout.write(docker("run", "--rm", "--network", name, "--mount", mount, "-e", "SMOKE_PASSWORD", "--entrypoint", "node", image, "/smoke.mjs", phase));
    }
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    try { process.stderr.write(docker("logs", "--tail", "100", gateway)); } catch { /* startup may have failed */ }
    process.exitCode = 1;
  } finally {
    // Remove only uniquely named resources created by this run, never user data.
    for (const args of created.reverse()) {
      try { docker(...args); } catch (error) { process.stderr.write(`Cleanup failed: ${args.join(" ")}\n`); process.exitCode = 1; }
    }
  }
}
