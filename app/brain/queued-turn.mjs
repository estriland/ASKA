// brain/queued-turn.mjs
const DEFAULT_TIMEOUT_MS = 90_000;

function assistantText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function turnError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

export async function awaitAgentTurn({ session, startTurn, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress } = {}) {
  if (!session || typeof session.subscribe !== 'function' || typeof session.abort !== 'function') {
    throw new TypeError('awaitAgentTurn requires an AgentSession');
  }
  if (typeof startTurn !== 'function') throw new TypeError('startTurn must be a function');
  if (signal?.aborted) throw turnError('AGENT_TURN_ABORTED', 'agent turn aborted before start');

  const initialMessages = session.state?.messages ?? [];
  const baseMessages = new Set(initialMessages);
  const baseContent = new Set(initialMessages.map(message => JSON.stringify(message)));
  let lastAssistant = null;
  let active = true;
  let timer = null;
  let timedOut = false;
  let aborted = false;
  let stopPromise = null;

  const emitProgress = (event) => {
    if (!active || typeof onProgress !== 'function') return;
    try { onProgress(event); } catch { /* progress must not fail the turn */ }
  };

  let unsubscribe;
  try {
    unsubscribe = session.subscribe((event) => {
      if (!active) return;
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        lastAssistant = event.message;
      } else if (event.type === 'agent_end' && event.willRetry) {
        emitProgress({ stage: 'retrying' });
      } else if (event.type === 'auto_retry_start') {
        emitProgress({ stage: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts });
      } else if (event.type === 'auto_retry_end' && event.success) {
        emitProgress({ stage: 'retrying', done: true, attempt: event.attempt });
      }
    });
  } catch (error) {
    throw turnError('AGENT_TURN_SUBSCRIBE', 'failed to subscribe to agent events', error);
  }

  const stop = (reason) => {
    if (stopPromise) return stopPromise;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'abort') aborted = true;
    stopPromise = (async () => {
      try { await session.abort(); } catch { /* best effort; keep original reason */ }
    })();
    return stopPromise;
  };

  const onAbort = () => { void stop('abort'); };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  const waitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  timer = setTimeout(() => { void stop('timeout'); }, waitMs);

  let promptError = null;
  try {
    await Promise.resolve().then(() => {
      if (aborted || timedOut || signal?.aborted) throw turnError('AGENT_TURN_ABORTED', 'cancelled before dispatch');
      return startTurn(session);
    });
  } catch (error) {
    promptError = error;
  }

  // If abort/timeout was requested, wait for the SDK run to unwind before
  // releasing the subscription and timer.
  if (stopPromise) await stopPromise;
  active = false;
  if (timer) clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (typeof unsubscribe === 'function') unsubscribe();

  if (timedOut) throw turnError('AGENT_TURN_TIMEOUT', 'agent turn timed out');
  if (aborted || signal?.aborted) throw turnError('AGENT_TURN_ABORTED', 'agent turn aborted');

  let finalAssistant = lastAssistant;
  if (!finalAssistant) {
    const added = (session.state?.messages ?? [])
      .filter((message) => !baseMessages.has(message) && !baseContent.has(JSON.stringify(message)) && message?.role === 'assistant');
    finalAssistant = added.at(-1) ?? null;
  }

  if (promptError) {
    if (finalAssistant?.stopReason === 'error' || finalAssistant?.stopReason === 'aborted') {
      // Prefer the terminal assistant's error, but retain the prompt error too.
      promptError.cause = finalAssistant;
    }
    throw turnError('AGENT_TURN_ERROR', 'agent turn failed: ' + String(promptError.message ?? promptError), promptError);
  }
  if (!finalAssistant) throw turnError('AGENT_TURN_EMPTY', 'agent turn produced no assistant message');
  if (finalAssistant.stopReason === 'aborted') {
    throw turnError('AGENT_TURN_ABORTED', 'agent assistant ended aborted', finalAssistant);
  }
  if (finalAssistant.stopReason === 'error') {
    throw turnError('AGENT_TURN_ERROR', finalAssistant.errorMessage || 'agent assistant ended with error', finalAssistant);
  }
  if (finalAssistant.stopReason === 'pending' || finalAssistant.stopReason === 'toolUse') {
    throw turnError('AGENT_TURN_EMPTY', 'agent assistant did not reach a final text result', finalAssistant);
  }

  const text = assistantText(finalAssistant);
  if (!text.trim()) throw turnError('AGENT_TURN_EMPTY', 'agent assistant text is empty', finalAssistant);
  return text;
}
