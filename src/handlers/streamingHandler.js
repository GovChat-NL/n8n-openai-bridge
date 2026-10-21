/*
 * n8n OpenAI Bridge
 * Copyright (C) 2025 Sven Eisenschmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const { createStreamingChunk } = require('../utils/openaiResponse');
const { createErrorResponse } = require('../utils/errorResponse');
const { encodeLibreChatStepEvent } = require('../utils/libreChatEventProtocol');

/**
 * Handles streaming chat completion requests
 *
 * @param {Object} res - Express response object
 * @param {Object} n8nClient - N8N client instance
 * @param {string} webhookUrl - Webhook URL for the model
 * @param {Array<Object>} messages - Chat messages
 * @param {string} sessionId - Session identifier
 * @param {Object} userContext - User context data
 * @param {string} model - Model identifier
 * @param {Object} config - Configuration object
 * @param {string} runId - Response/run identifier for LibreChat step events
 * @returns {Promise<void>}
 */
async function handleStreaming(
  res,
  n8nClient,
  webhookUrl,
  messages,
  sessionId,
  userContext,
  model,
  config,
  runId,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (config.diagnosticLogging) {
      console.log(
        `[diag][bridge][streaming] start sessionId=${sessionId} runId=${runId} webhookUrl=${webhookUrl}`,
      );
    }
    const streamGenerator = n8nClient.streamCompletion(
      webhookUrl,
      messages,
      sessionId,
      userContext,
      { runId, requestId: res.req?.id },
    );

    for await (const content of streamGenerator) {
      if (content && typeof content === 'object' && content.kind === 'librechat_step_event') {
        if (config.diagnosticLogging) {
          console.log(
            `[diag][bridge][${res.req?.id || 'no-request-id'}] sse_step_event event=${content.payload?.event || 'unknown'} runId=${runId}`,
          );
        }
        // LangChain's OpenAI-compatible client ignores named SSE events. Carry
        // this private control frame as ordinary content; LibreChat's agent
        // callback overlay removes/decodes it before user-visible aggregation.
        const chunk = createStreamingChunk(model, encodeLibreChatStepEvent(content.payload), null);
        res.write('event: message\n');
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        continue;
      }

      const chunk = createStreamingChunk(model, content, null);
      if (config.diagnosticLogging) {
        console.log(
          `[diag][bridge][${res.req?.id || 'no-request-id'}] sse_text_chunk runId=${runId} preview=${JSON.stringify(String(content).slice(0, 120))}`,
        );
      }
      res.write('event: message\n');
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Send final chunk
    const finalChunk = createStreamingChunk(model, null, 'stop');
    res.write('event: message\n');
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('event: message\n');
    res.write('data: [DONE]\n\n');
    res.end();

    if (config.logRequests) {
      console.log(`Streaming completed for session: ${sessionId}`);
    }
  } catch (streamError) {
    console.error('Stream error:', streamError);
    const errorChunk = createErrorResponse('Error during streaming', 'server_error');
    res.write('event: message\n');
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.end();
  }
}

module.exports = { handleStreaming };
