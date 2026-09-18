// Real production-image check. Node >=22 + Docker; no provider credentials or paid calls.
// node tests/docker-smoke.mjs <image>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

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
      assert(["https://api.commandcode.ai", "https://chatgpt.com"].includes(target));
      assert(["/alpha/generate", "/backend-api/codex/responses"].includes(path));
      const command = target.includes("commandcode");
      assert.equal(command ? body.params.stream : body.stream, true);
      const model = command ? body.params.model : body.model;
      const truncated = req.url === "/truncated";
      const failed = req.url === "/failed";
      seen.push({ target, path, model, truncated, failed });
      const ndjson = [
        { type: "start" },
        { type: "reasoning-delta", text: "Inspect fixture." },
        { type: "text-delta", text: "Reading fixture." },
        { type: "tool-input-start", id: tool.id, toolName: tool.name },
        { type: "tool-input-delta", id: tool.id, delta: tool.arguments },
        { type: "tool-call", toolCallId: tool.id, toolName: tool.name, input },
        ...(!truncated ? [
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
          ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
          ...(!truncated ? [{ type: "response.completed", response: { id: "resp_fixture", model, status: "completed", output, usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } }] : []),
        ];
      res.setHeader("Content-Type", "text/event-stream");
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
    async function invoke(path, model, stream, expected = 200) {
      const responses = path.endsWith("responses");
      const body = responses
        ? { model, stream, input: [{ role: "user", content: "Read fixture" }], tools: [{ type: "function", name: "Read", parameters: properties }] }
        : { model, stream, max_tokens: 128, messages: [{ role: "user", content: "Read fixture" }], tools: [{ name: "Read", input_schema: properties }] };
      const response = await fetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      const wire = await response.text();
      assert.equal(response.status, expected, `${path} ${model}: ${wire.slice(0,500)}`);
      if (expected !== 200) { assert(JSON.parse(wire).error); return; }
      if (stream) {
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const events = wire.split(/\r?\n/).filter(l => l.startsWith("data:") && l.slice(5).trim() !== "[DONE]").map(l => JSON.parse(l.slice(5)));
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
    for (const [connection, provider, route] of [[cmc, "cmc", "truncated"], [codex, "cx", "truncated"], [codex, "cx", "failed"]]) {
      const badPool = (await admin("/api/proxy-pools", { name: route, type: "vercel", proxyUrl: `http://fixture:8080/${route}` })).proxyPool;
      await admin(`/api/providers/${connection.id}`, { proxyPoolId: badPool.id }, "PUT");
      await invoke("/v1/messages", `${provider}/fixture-${route}`, false, 502);
      console.log(`PASS rejects ${provider} ${route} upstream`);
    }
    const seen = await (await fetch("http://fixture:8080/seen")).json();
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
  const docker = (...args) => execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
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
