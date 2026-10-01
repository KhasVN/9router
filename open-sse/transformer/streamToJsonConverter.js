/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function asError(value, fallback = "upstream response failed") {
  if (typeof value === "string" && value) return { message: value };
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return { message: fallback };
}

function applyUsage(state, payload) {
  const usage = payload?.response?.usage || payload?.usage;
  if (!usage || typeof usage !== "object") return;
  state.usage = { ...state.usage, ...usage };
}

/**
 * Process one complete SSE event block.
 */
function processSSEMessage(msg, state) {
  if (state.terminalSeen || !msg.trim()) return;

  let eventType = null;
  const dataLines = [];
  for (const line of msg.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return;

  const dataStr = dataLines.join("\n").trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  const type = eventType || parsed.type;
  const response = parsed.response && typeof parsed.response === "object" ? parsed.response : parsed;
  const status = response?.status || parsed.status;

  if (type === "response.created") {
    state.responseId = response.id || state.responseId;
    state.created = response.created_at || state.created;
  }

  if (type === "response.output_item.done" && response.item) {
    state.items.set(parsed.output_index ?? state.items.size, response.item);
  }

  if (Array.isArray(response?.output)) {
    for (const [index, item] of response.output.entries()) state.items.set(index, item);
  }

  applyUsage(state, parsed);

  const errorValue = parsed.error || response?.error;
  if (type === "error" || type === "response.failed" || status === "failed" || status === "cancelled" || errorValue) {
    state.status = status === "cancelled" || type === "response.cancelled" ? "cancelled" : "failed";
    state.error = asError(errorValue, status === "cancelled" ? "upstream response cancelled" : "upstream response failed");
    state.terminalSeen = true;
    return;
  }

  if (type === "response.incomplete" || status === "incomplete") {
    state.status = "incomplete";
    state.incompleteDetails = response.incomplete_details || parsed.incomplete_details || null;
    state.terminalSeen = true;
    return;
  }

  if (type === "response.completed" || type === "response.done") {
    state.status = status || "completed";
    state.terminalSeen = true;
  }
}

function buildOutput(state) {
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }
  return output;
}

/**
 * Convert Responses API SSE stream to single JSON response.
 * Failed, cancelled, incomplete, and truncated streams stay non-successful;
 * no EOF path is allowed to become status=completed.
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return {
      id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
      status: "failed", output: [], usage: { ...EMPTY_RESPONSE }, error: { message: "missing Responses stream" }
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    terminalSeen: false,
    error: null,
    incompleteDetails: null,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";
      for (const msg of messages) processSSEMessage(msg, state);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processSSEMessage(buffer, state);
  } catch (error) {
    state.status = "failed";
    state.error = asError(error?.message, "Responses stream read failed");
  } finally {
    reader.releaseLock();
  }

  if (!state.terminalSeen && state.status === "in_progress") {
    state.status = "failed";
    state.error = { message: "stream closed before response.completed" };
  }

  const result = {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status,
    output: buildOutput(state),
    usage: state.usage,
    error: state.error
  };
  if (state.incompleteDetails) result.incomplete_details = state.incompleteDetails;
  return result;
}
