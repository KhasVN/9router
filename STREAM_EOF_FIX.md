# Fix: stream disconnected before completion

## Problem
Codex upstream closes connection after delivering content but without sending `response.completed` terminal event.
Router sees EOF → throws "stream closed before response.completed" → client sees 502.

## Root Causes
1. **Translator** (`openaiResponsesToOpenAIResponse` line 586-588): throws on null chunk if no `finishReasonSent`
2. **StreamToJsonConverter** (line 136-139): marks EOF as failed if `status === "in_progress"` and no `terminalSeen`
3. **Codex peek timeout** (1s): races against slow reasoning; if timeout wins before content arrives, may discard buffered terminal event

## Safe Auto-Complete Criteria
Content delivered + clean state + no error:

**Translator:**
- `completedOutputItems.size > 0` (has finished message/tool items) OR
- `Object.keys(msgTextBuf).some(k => msgTextBuf[k])` (has buffered text)
- AND no partial tool calls: `!Object.keys(funcCallIds).some(k => !funcItemDone[k])`

**StreamToJsonConverter:**
- `state.items.size > 0` (has output_item.done entries)

**Must still fail:**
- Empty generation (no items/content)
- Mid-tool-call EOF (funcCallIds has entry, funcItemDone[idx] false)
- Error events
- Partial buffer without complete item

## Implementation

### 1. Translator (openai-responses.js:586-589)
```javascript
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    if (state.finishReasonSent) return null;
    
    // Graceful completion: content delivered, no partial tools, clean EOF
    const hasContent = (state.completedOutputItems?.size > 0) ||
      Object.keys(state.msgTextBuf || {}).some(k => state.msgTextBuf[k]);
    const hasPartialTools = Object.keys(state.funcCallIds || {}).some(k => !state.funcItemDone?.[k]);
    
    if (hasContent && !hasPartialTools) {
      // Codex closed cleanly after delivering content; synthesize stop
      state.responsesTerminalSeen = true;
      return handleResponsesTerminal(state, "response.completed", {
        response: { status: "completed" }
      });
    }
    
    throwResponsesFailure(state, "error", { message: "stream closed before response.completed" });
  }
```

### 2. StreamToJsonConverter (streamToJsonConverter.js:136-139)
```javascript
  if (!state.terminalSeen && state.status === "in_progress") {
    // Graceful completion: items delivered via output_item.done
    if (state.items.size > 0) {
      state.status = "completed";
    } else {
      state.status = "failed";
      state.error = { message: "stream closed before response.completed" };
    }
  }
```

### 3. Tests
Add regression coverage:
- Partial text + clean EOF → completed (not failed)
- output_item.done + EOF → completed
- Empty generation + EOF → failed (preserve)
- Mid-tool-call EOF → failed (preserve)

## Edge Cases Preserved
- Error events → immediate fail
- Empty stream → fail
- Partial tool call → fail
- Explicit status=failed → fail
