/*
 * A tiny content-level sideband for LibreChat lifecycle events.
 *
 * The OpenAI-compatible HTTP stream is consumed by LangChain, which only
 * understands `data:` chat.completion chunks. Named SSE events are discarded
 * by that parser, so lifecycle payloads must travel inside ordinary content
 * until the LibreChat agent callback decodes them.
 */
const PREFIX = '\u001eLCSTEP:';
const SUFFIX = '\u001f';
const MAX_ENCODED_EVENT_LENGTH = 256 * 1024;
const ALLOWED_EVENTS = new Set([
  'on_run_step',
  'on_run_step_delta',
  'on_run_step_completed',
  'on_run_step_closed',
]);

function encodeLibreChatStepEvent(event) {
  if (
    !event ||
    typeof event !== 'object' ||
    !ALLOWED_EVENTS.has(event.event) ||
    !event.data ||
    typeof event.data !== 'object' ||
    Array.isArray(event.data)
  ) {
    throw new TypeError('Invalid LibreChat step event');
  }

  const encoded = Buffer.from(JSON.stringify(event), 'utf8').toString('base64url');
  if (encoded.length > MAX_ENCODED_EVENT_LENGTH) {
    throw new RangeError('LibreChat step event exceeds the sideband size limit');
  }
  return `${PREFIX}${encoded}${SUFFIX}`;
}

/**
 * Incrementally extracts encoded lifecycle events from model text. It handles
 * markers split across arbitrary token/chunk boundaries and retains text
 * before and after each marker in wire order.
 */
function createLibreChatStepEventDecoder() {
  let pending = '';

  return {
    push(value) {
      pending += String(value ?? '');
      const segments = [];

      while (pending.length > 0) {
        const markerStart = pending.indexOf(PREFIX);
        if (markerStart < 0) {
          // Keep only a possible partial prefix at the end; all prior bytes
          // are known to be ordinary model text and can be rendered now.
          let keep = 0;
          const maxCandidate = Math.min(PREFIX.length - 1, pending.length);
          for (let size = maxCandidate; size > 0; size--) {
            if (pending.endsWith(PREFIX.slice(0, size))) {
              keep = size;
              break;
            }
          }
          const ordinary = keep ? pending.slice(0, -keep) : pending;
          if (ordinary) {
            segments.push({ type: 'text', text: ordinary });
          }
          pending = keep ? pending.slice(-keep) : '';
          break;
        }

        if (markerStart > 0) {
          segments.push({ type: 'text', text: pending.slice(0, markerStart) });
          pending = pending.slice(markerStart);
        }

        const payloadStart = PREFIX.length;
        const markerEnd = pending.indexOf(SUFFIX, payloadStart);
        if (markerEnd < 0) {
          if (pending.length > MAX_ENCODED_EVENT_LENGTH + PREFIX.length) {
            // Invalid/oversized control-like output is treated as plain text,
            // not silently swallowed or allowed to grow memory without bound.
            segments.push({ type: 'text', text: pending });
            pending = '';
          }
          break;
        }

        const marker = pending.slice(0, markerEnd + SUFFIX.length);
        const encoded = pending.slice(payloadStart, markerEnd);
        pending = pending.slice(markerEnd + SUFFIX.length);
        try {
          const event = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
          if (
            event &&
            typeof event === 'object' &&
            ALLOWED_EVENTS.has(event.event) &&
            event.data &&
            typeof event.data === 'object' &&
            !Array.isArray(event.data)
          ) {
            segments.push({ type: 'event', event });
            continue;
          }
        } catch {
          // Preserve malformed/untrusted content verbatim below.
        }
        segments.push({ type: 'text', text: marker });
      }

      return segments;
    },

    /** Flush an unfinished marker as literal text at a stream boundary. */
    flush() {
      if (!pending) {
        return [];
      }
      const text = pending;
      pending = '';
      return [{ type: 'text', text }];
    },
  };
}

module.exports = {
  PREFIX,
  SUFFIX,
  encodeLibreChatStepEvent,
  createLibreChatStepEventDecoder,
};
