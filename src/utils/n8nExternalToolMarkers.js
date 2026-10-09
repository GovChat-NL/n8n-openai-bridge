const MARKER_PREFIX = '<!--GOVCHAT_EXTERNAL_TOOL:';
const MARKER_SUFFIX = '-->';
const MARKER_PATTERN = /<!--GOVCHAT_EXTERNAL_TOOL:([\s\S]*?)-->/g;

function normalizeExternalToolMarker(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const id = String(value.id || '').trim();
  const name = String(value.name || '').trim();
  if (!id || !name) {
    return null;
  }

  const argumentsValue =
    typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments || {});

  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: argumentsValue,
    },
  };
}

/**
 * Removes trusted n8n external-tool markers from text and returns their
 * OpenAI-compatible tool-call representation. The marker is emitted only by
 * the version-pinned n8n image patch and never reaches the chat UI as text.
 */
function extractExternalToolMarkers(content) {
  if (typeof content !== 'string' || !content.includes(MARKER_PREFIX)) {
    return { content, toolCalls: [] };
  }

  const toolCalls = [];
  const cleanedContent = content.replace(MARKER_PATTERN, (_match, rawPayload) => {
    try {
      const toolCall = normalizeExternalToolMarker(JSON.parse(rawPayload));
      if (toolCall) {
        toolCalls.push(toolCall);
      }
    } catch {
      // Invalid marker content is removed rather than rendered to the user.
    }
    return '';
  });

  return { content: cleanedContent, toolCalls };
}

module.exports = {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  extractExternalToolMarkers,
  normalizeExternalToolMarker,
};
