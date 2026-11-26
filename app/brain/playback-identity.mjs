// Presentation-only identity. Never inserted into a model's message content.
export function messagePlaybackId(manager, message = null) {
  if (message && message.role !== 'assistant') return null;
  const entry = [...manager.getBranch()].reverse().find(entry =>
    entry.type === 'message' && entry.message?.role === 'assistant' &&
    (!message || (entry.message.timestamp === message.timestamp &&
      JSON.stringify(entry.message.content) === JSON.stringify(message.content))));
  return entry ? `${manager.getSessionId()}:${entry.id}` : null;
}
