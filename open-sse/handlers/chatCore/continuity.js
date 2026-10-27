/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

// Responses upstreams (OpenAI, Meta, Codex) reject a reasoning input item with no
// `summary` array; clients/translators often drop it when it is empty.
export function ensureReasoningSummary(body) {
  if (!body || !Array.isArray(body.input)) return body;
  for (const item of body.input) {
    if (item && item.type === "reasoning" && !Array.isArray(item.summary)) item.summary = [];
  }
  return body;
}
