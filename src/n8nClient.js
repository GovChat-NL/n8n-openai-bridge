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

const axios = require('axios');
const FormData = require('form-data');
const { StringDecoder } = require('string_decoder');
const {
  createRunStepEvent,
  createRunStepCompletedEvent,
  createRunStepClosedEvent,
} = require('./utils/libreChatEvents');
const {
  processMessages,
  filesToBuffers,
  extractTextFromMultimodal,
  isMultimodalMessage,
} = require('./utils/fileProcessor');

class N8nClient {
  /** @type {Set<string>} Chunk types treated as metadata (no content extracted) */
  static METADATA_TYPES = new Set(['begin', 'end', 'error', 'metadata']);

  constructor(config, taskDetectorService = null) {
    this.config = config;
    this.taskDetectorService = taskDetectorService;
    this.MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max buffer size
  }

  getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.n8nWebhookBearerToken) {
      headers['Authorization'] = `Bearer ${this.config.n8nWebhookBearerToken}`;
    }
    return headers;
  }

  buildPayload(messages, sessionId, userContext) {
    const fileUploadMode = this.config.fileUploadMode || 'passthrough';

    // Process messages according to file upload mode
    const { messages: processedMessages, files } = processMessages(messages, fileUploadMode);

    // Extract system prompt (handle multimodal content)
    const systemMessage = processedMessages.find((m) => m.role === 'system');
    const systemPrompt = systemMessage
      ? isMultimodalMessage(systemMessage)
        ? extractTextFromMultimodal(systemMessage)
        : systemMessage.content || ''
      : '';

    // Extract current message (handle multimodal content)
    const lastMessage = processedMessages[processedMessages.length - 1];
    const currentMessage = lastMessage
      ? isMultimodalMessage(lastMessage)
        ? extractTextFromMultimodal(lastMessage)
        : lastMessage.content || ''
      : '';

    const payload = {
      systemPrompt,
      currentMessage,
      chatInput: currentMessage,
      messages: processedMessages.filter((m) => m.role !== 'system'),
      sessionId,
      userId: userContext.userId,
      isTask: false,
      taskType: null,
    };

    // Add files array for extract-json mode
    if (fileUploadMode === 'extract-json' && files.length > 0) {
      payload.files = files;
    }

    // Add optional user fields if provided
    if (userContext.userEmail) {
      payload.userEmail = userContext.userEmail;
    }
    if (userContext.userName) {
      payload.userName = userContext.userName;
    }
    if (userContext.userRole) {
      payload.userRole = userContext.userRole;
    }

    // Add task detection if enabled
    if (this.config.enableTaskDetection && this.taskDetectorService) {
      const taskDetection = this.taskDetectorService.detectTask(messages);
      if (taskDetection.isTask) {
        payload.isTask = true;
        payload.taskType = taskDetection.taskType;
      }
    }

    // Store files for multipart mode (used by request methods)
    this._pendingFiles = fileUploadMode === 'extract-multipart' ? files : [];

    return payload;
  }

  /**
   * Process response stream and extract JSON chunks
   * Shared method to eliminate duplication between streaming and non-streaming
   * @private
   */
  async *processResponseStream(response, options = {}) {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let hasYieldedContent = false;
    let pendingTurnSeparator = false;
    const turnSeparator = this.config.agentTurnSeparator ?? '\n\n';
    const runId = options.runId;
    const requestId = options.requestId;
    const activeToolSteps = new Map();
    let nextToolStepIndex = 0;
    let nextTextToolCallId = 0;
    let firstTextChunkLogged = false;
    let syntheticToolStepEmitted = false;
    let metadataToolStepEmitted = false;
    const filterToolCallText = createToolCallTextFilter(this.MAX_BUFFER_SIZE);

    const runtimeToolCallStart = this.extractRuntimeToolCallStart(response, runId);
    let rawChunkLogCount = 0;
    let parsedChunkLogCount = 0;

    const emitToolStepCompletion = (toolStep, output = '') => {
      if (!toolStep) {
        return [];
      }

      const completedAt = Date.now();
      return [
        {
          kind: 'librechat_step_event',
          payload: createRunStepCompletedEvent({
            stepId: toolStep.stepId,
            toolCallId: toolStep.toolCallId,
            toolName: toolStep.toolName,
            toolArgs: toolStep.toolArgs,
            output,
            completedAt,
          }),
        },
        {
          kind: 'librechat_step_event',
          payload: createRunStepClosedEvent({
            stepId: toolStep.stepId,
            completedAt,
          }),
        },
      ];
    };

    const emitToolStepStart = (toolCallStart, source = 'stream') => {
      if (!toolCallStart || !runId) {
        return null;
      }

      const stepId = `step_${toolCallStart.id}`;
      const existingToolStep = activeToolSteps.get(toolCallStart.id);
      if (existingToolStep) {
        return null;
      }

      const toolStep = {
        stepId,
        toolCallId: toolCallStart.id,
        toolName: toolCallStart.name,
        toolArgs: toolCallStart.args,
      };
      activeToolSteps.set(toolCallStart.id, toolStep);
      if (this.config.diagnosticLogging) {
        console.log(
          `[diag][bridge][${requestId || 'no-request-id'}] tool_start_detected source=${source} runId=${runId} toolCallId=${toolStep.toolCallId} toolName=${toolStep.toolName} activeToolSteps=${activeToolSteps.size}`,
        );
      }
      return {
        kind: 'librechat_step_event',
        payload: createRunStepEvent({
          stepId: toolStep.stepId,
          runId,
          toolCallId: toolStep.toolCallId,
          toolName: toolStep.toolName,
          toolArgs: toolStep.toolArgs,
          index: nextToolStepIndex++,
        }),
      };
    };

    const maybeCreateSyntheticToolCallStart = (data) => {
      if (
        syntheticToolStepEmitted ||
        !runId ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        data.type
      ) {
        return null;
      }

      const candidateName =
        typeof data.toolName === 'string'
          ? data.toolName
          : typeof data.tool === 'string'
            ? data.tool
            : typeof data.name === 'string'
              ? data.name
              : '';

      if (!candidateName) {
        return null;
      }

      const candidateArgs = data.toolArgs ?? data.arguments ?? data.args ?? data.input ?? '';
      const candidateId =
        typeof data.toolCallId === 'string' && data.toolCallId
          ? data.toolCallId
          : `synthetic_${runId}_${candidateName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      syntheticToolStepEmitted = true;
      return {
        id: candidateId,
        name: candidateName,
        args: candidateArgs,
      };
    };

    const maybeCreateMetadataToolCallStart = (data) => {
      if (
        metadataToolStepEmitted ||
        syntheticToolStepEmitted ||
        !runId ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
      ) {
        return null;
      }

      const metadata = data.metadata;
      if (!metadata || typeof metadata !== 'object') {
        return null;
      }

      const nodeName =
        typeof metadata.nodeName === 'string'
          ? metadata.nodeName
          : typeof data.nodeName === 'string'
            ? data.nodeName
            : '';
      const nodeId =
        typeof metadata.nodeId === 'string'
          ? metadata.nodeId
          : typeof data.nodeId === 'string'
            ? data.nodeId
            : '';
      const type = typeof data.type === 'string' ? data.type : '';

      if (!nodeName || !nodeId || !type) {
        return null;
      }

      const normalizedNodeName = nodeName.trim();
      const looksLikeToolNode =
        normalizedNodeName !== 'AI Agent Orchestrator' &&
        (normalizedNodeName.endsWith('_tool') || normalizedNodeName.includes('tool'));

      if (!looksLikeToolNode) {
        return null;
      }

      if (type !== 'begin' && type !== 'item' && type !== 'error') {
        return null;
      }

      metadataToolStepEmitted = true;
      syntheticToolStepEmitted = true;
      return {
        id: `metadata_${runId}_${nodeId}`,
        name: normalizedNodeName,
        args: '',
      };
    };

    if (this.config.diagnosticLogging) {
      const runtimeEnvelope = response?.data?.runtime;
      console.log(
        `[diag][bridge][${requestId || 'no-request-id'}] response_runtime_envelope runId=${runId} payload=${JSON.stringify(runtimeEnvelope ?? null).slice(0, 1000)}`,
      );
    }

    const runtimeStepStartEvent = emitToolStepStart(runtimeToolCallStart, 'response-runtime');
    if (runtimeStepStartEvent) {
      syntheticToolStepEmitted = true;
      yield runtimeStepStartEvent;
      if (this.config.diagnosticLogging) {
        console.log(
          `[diag][bridge][${requestId || 'no-request-id'}] run_step_emitted runId=${runId} stepId=${runtimeStepStartEvent.payload.data.id} toolCallId=${runtimeStepStartEvent.payload.data.stepDetails.tool_calls[0].id}`,
        );
      }
    }

    for await (const chunk of response.data) {
      const text = decoder.write(chunk);
      buffer += text;

      if (this.config.diagnosticLogging && rawChunkLogCount < 12) {
        rawChunkLogCount += 1;
        console.log(
          `[diag][bridge][${requestId || 'no-request-id'}] raw_stream_chunk#${rawChunkLogCount} runId=${runId} preview=${JSON.stringify(String(text).slice(0, 500))}`,
        );
      }

      // Check buffer size to prevent memory exhaustion
      if (buffer.length > this.MAX_BUFFER_SIZE) {
        throw new Error(`Response buffer exceeded maximum size of ${this.MAX_BUFFER_SIZE} bytes`);
      }

      // Process JSON chunks
      if (buffer.includes('{') && buffer.includes('}')) {
        const chunks = this.extractJsonChunks(buffer);
        buffer = chunks.remainder;

        for (const jsonChunk of chunks.extracted) {
          let parsed = this.parseN8nChunk(jsonChunk);
          if (this.config.diagnosticLogging && parsedChunkLogCount < 20) {
            parsedChunkLogCount += 1;
            console.log(
              `[diag][bridge][${requestId || 'no-request-id'}] parsed_chunk#${parsedChunkLogCount} runId=${runId} raw=${JSON.stringify(parsed.raw).slice(0, 1200)} content=${JSON.stringify(parsed.content)} toolCallStart=${JSON.stringify(parsed.toolCallStart)} toolCallEnd=${JSON.stringify(parsed.toolCallEnd)} isEndOfTurn=${parsed.isEndOfTurn}`,
            );
          }
          const syntheticToolCallStart = maybeCreateSyntheticToolCallStart(parsed.raw);
          const metadataToolCallStart = maybeCreateMetadataToolCallStart(parsed.raw);
          if ((syntheticToolCallStart || metadataToolCallStart) && !parsed.toolCallStart) {
            parsed = {
              ...parsed,
              toolCallStart: syntheticToolCallStart || metadataToolCallStart,
            };
          }

          let content = parsed.content;
          let toolCallStart = parsed.toolCallStart;
          const { isEndOfTurn, toolCallEnd } = parsed;
          const filteredText = filterToolCallText(content);
          content = filteredText.text;

          const stepStartEvent = emitToolStepStart(
            toolCallStart,
            syntheticToolCallStart
              ? 'synthetic-runtime'
              : metadataToolCallStart
                ? 'metadata-node'
                : 'stream',
          );
          if (stepStartEvent) {
            yield stepStartEvent;
            if (this.config.diagnosticLogging) {
              console.log(
                `[diag][bridge][${requestId || 'no-request-id'}] run_step_emitted runId=${runId} stepId=${stepStartEvent.payload.data.id} toolCallId=${stepStartEvent.payload.data.stepDetails.tool_calls[0].id}`,
              );
            }
          }

          for (const candidate of filteredText.toolCalls) {
            const contentToolCallStart = {
              id:
                candidate.id ||
                candidate.toolCallId ||
                `text_${runId || 'run'}_${nextTextToolCallId++}`,
              name: candidate.name || candidate.tool,
              args: candidate.arguments ?? candidate.args ?? candidate.input ?? '',
            };
            const contentStepStartEvent = emitToolStepStart(contentToolCallStart, 'content-tool-call');
            if (contentStepStartEvent) {
              yield contentStepStartEvent;
            }
          }

          const metadataNodeId =
            parsed.raw && parsed.raw.metadata && typeof parsed.raw.metadata.nodeId === 'string'
              ? parsed.raw.metadata.nodeId
              : '';
          const metadataToolCallId = metadataNodeId ? `metadata_${runId}_${metadataNodeId}` : '';
          const metadataToolStep = metadataToolCallId ? activeToolSteps.get(metadataToolCallId) : null;
          const metadataToolShouldComplete =
            metadataToolStep &&
            ((parsed.raw && parsed.raw.type === 'error') ||
              (parsed.raw && parsed.raw.type === 'end' && parsed.raw.metadata?.nodeName !== 'AI Agent Orchestrator'));

          if (toolCallEnd || metadataToolShouldComplete) {
            const completedToolStep =
              (toolCallEnd && toolCallEnd.id && activeToolSteps.get(toolCallEnd.id)) ||
              (toolCallEnd && toolCallEnd.name
                ? [...activeToolSteps.values()].find((step) => step.toolName === toolCallEnd.name)
                : null) ||
              metadataToolStep ||
              (activeToolSteps.size === 1 ? activeToolSteps.values().next().value : null);

            if (completedToolStep) {
              if (this.config.diagnosticLogging) {
                const matchedBy =
                  toolCallEnd.id && activeToolSteps.has(toolCallEnd.id)
                    ? 'id'
                    : toolCallEnd.name
                      ? 'tool-name'
                      : 'single-active-fallback';
                console.log(
                  `[diag][bridge][${requestId || 'no-request-id'}] tool_end_detected runId=${runId} toolCallId=${completedToolStep.toolCallId} matchedBy=${matchedBy}`,
                );
              }
              const completionOutput = toolCallEnd?.error
                ? `Tool failed: ${toolCallEnd.error}`
                : toolCallEnd?.output || '';
              for (const event of emitToolStepCompletion(completedToolStep, completionOutput)) {
                yield event;
              }
              activeToolSteps.delete(completedToolStep.toolCallId);
            }
          }

          // Track agent turn boundaries to inject separators
          if (isEndOfTurn && hasYieldedContent) {
            pendingTurnSeparator = true;
          }

          if (content) {
            if (!firstTextChunkLogged && this.config.diagnosticLogging) {
              firstTextChunkLogged = true;
              console.log(
                `[diag][bridge][${requestId || 'no-request-id'}] first_text_chunk runId=${runId} preview=${JSON.stringify(String(content).slice(0, 120))}`,
              );
            }
            if (pendingTurnSeparator) {
              if (turnSeparator) {
                yield turnSeparator;
              }
              pendingTurnSeparator = false;
            }
            hasYieldedContent = true;
            yield content;
          }
        }
      }
    }

    // Flush any remaining buffered UTF-8 bytes
    buffer += decoder.end();

    // Process remaining buffer
    if (buffer.trim()) {
      const parsed = this.parseN8nChunk(buffer.trim());
      if (this.config.diagnosticLogging) {
        console.log(
          `[diag][bridge][${requestId || 'no-request-id'}] trailing_buffer_parsed runId=${runId} raw=${JSON.stringify(parsed.raw).slice(0, 1200)} content=${JSON.stringify(parsed.content)} toolCallStart=${JSON.stringify(parsed.toolCallStart)} toolCallEnd=${JSON.stringify(parsed.toolCallEnd)}`,
        );
      }
      const syntheticToolCallStart = maybeCreateSyntheticToolCallStart(parsed.raw);
      const metadataToolCallStart = maybeCreateMetadataToolCallStart(parsed.raw);
      const stepStartEvent = emitToolStepStart(
        parsed.toolCallStart || syntheticToolCallStart || metadataToolCallStart,
        syntheticToolCallStart
          ? 'synthetic-runtime'
          : metadataToolCallStart
            ? 'metadata-node'
            : 'stream',
      );
      if (stepStartEvent) {
        yield stepStartEvent;
      }
      if (parsed.toolCallEnd) {
        const completedToolStep =
          (parsed.toolCallEnd.id && activeToolSteps.get(parsed.toolCallEnd.id)) ||
          (parsed.toolCallEnd.name
            ? [...activeToolSteps.values()].find((step) => step.toolName === parsed.toolCallEnd.name)
            : null) ||
          (activeToolSteps.size === 1 ? activeToolSteps.values().next().value : null);
        if (completedToolStep) {
          const completionOutput = parsed.toolCallEnd.error
            ? `Tool failed: ${parsed.toolCallEnd.error}`
            : parsed.toolCallEnd.output || '';
          for (const event of emitToolStepCompletion(completedToolStep, completionOutput)) {
            yield event;
          }
          activeToolSteps.delete(completedToolStep.toolCallId);
        }
      }
      const filteredText = filterToolCallText(parsed.content);
      for (const candidate of filteredText.toolCalls) {
        const stepStartEvent = emitToolStepStart(
          {
            id: candidate.id || candidate.toolCallId || `text_${runId || 'run'}_${nextTextToolCallId++}`,
            name: candidate.name || candidate.tool,
            args: candidate.arguments ?? candidate.args ?? candidate.input ?? '',
          },
          'content-tool-call',
        );
        if (stepStartEvent) {
          yield stepStartEvent;
        }
      }
      if (filteredText.text) {
        if (pendingTurnSeparator && turnSeparator) {
          yield turnSeparator;
        }
        yield filteredText.text;
      }
    }

    const remainingText = filterToolCallText('', true);
    if (remainingText.text) {
      yield remainingText.text;
    }
    for (const candidate of remainingText.toolCalls) {
      const stepStartEvent = emitToolStepStart(
        {
          id: candidate.id || candidate.toolCallId || `text_${runId || 'run'}_${nextTextToolCallId++}`,
          name: candidate.name || candidate.tool,
          args: candidate.arguments ?? candidate.args ?? candidate.input ?? '',
        },
        'content-tool-call',
      );
      if (stepStartEvent) {
        yield stepStartEvent;
      }
    }

    for (const danglingToolStep of activeToolSteps.values()) {
      if (this.config.diagnosticLogging) {
        console.log(
          `[diag][bridge][${requestId || 'no-request-id'}] synthetic_tool_end_on_stream_close runId=${runId} toolCallId=${danglingToolStep.toolCallId}`,
        );
      }
      for (const event of emitToolStepCompletion(danglingToolStep, '')) {
        yield event;
      }
    }
    activeToolSteps.clear();
  }

  /**
   * Build request config for axios, handling multipart mode
   * @param {Object} payload - JSON payload
   * @param {Array} files - Files to upload (for multipart mode)
   * @returns {Object} Axios request config
   * @private
   */
  buildRequestConfig(payload, files) {
    if (files && files.length > 0) {
      // Multipart mode - send payload fields directly for n8n compatibility
      const form = new FormData();

      // Add all payload fields as form fields
      for (const [key, value] of Object.entries(payload)) {
        if (value !== null && value !== undefined) {
          // Stringify objects/arrays, keep primitives as-is
          const formValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          form.append(key, formValue);
        }
      }

      // Add files as binary
      const bufferFiles = filesToBuffers(files);
      for (const file of bufferFiles) {
        form.append('files', file.buffer, {
          filename: file.name,
          contentType: file.mimeType,
        });
      }

      return {
        headers: {
          ...form.getHeaders(),
          ...(this.config.n8nWebhookBearerToken && {
            Authorization: `Bearer ${this.config.n8nWebhookBearerToken}`,
          }),
        },
        data: form,
        responseType: 'stream',
        timeout: this.config.n8nTimeout,
      };
    }

    // JSON mode
    return {
      headers: this.getHeaders(),
      data: payload,
      responseType: 'stream',
      timeout: this.config.n8nTimeout,
    };
  }

  async *streamCompletion(webhookUrl, messages, sessionId, userContext, options = {}) {
    const payload = this.buildPayload(messages, sessionId, userContext);
    const files = this._pendingFiles || [];
    this._pendingFiles = [];

    try {
      const config = this.buildRequestConfig(payload, files);
      const response = await axios.post(webhookUrl, config.data, {
        headers: config.headers,
        responseType: config.responseType,
        timeout: config.timeout,
      });

      // Use the shared stream processing method
      yield* this.processResponseStream(response, options);
    } catch (error) {
      console.error('Streaming error:', error.message);
      throw error;
    }
  }

  async nonStreamingCompletion(webhookUrl, messages, sessionId, userContext) {
    const payload = this.buildPayload(messages, sessionId, userContext);
    const files = this._pendingFiles || [];
    this._pendingFiles = [];

    try {
      // n8n always sends streams, so we need to handle it as a stream
      // and collect all content chunks
      const config = this.buildRequestConfig(payload, files);
      const response = await axios.post(webhookUrl, config.data, {
        headers: config.headers,
        responseType: config.responseType,
        timeout: config.timeout,
      });

      const collectedContent = [];

      // Use the shared stream processing method
      for await (const content of this.processResponseStream(response)) {
        collectedContent.push(content);
      }

      // Return all collected content as a single string
      return collectedContent.join('');
    } catch (error) {
      console.error('Non-streaming error:', error.message);
      throw error;
    }
  }

  extractJsonChunks(buffer) {
    const extracted = [];
    let remainder = buffer;

    while (true) {
      const startIdx = remainder.indexOf('{');
      if (startIdx === -1) {
        break;
      }

      let braceCount = 0;
      let endIdx = -1;
      let inString = false;
      let escapeNext = false;

      for (let i = startIdx; i < remainder.length; i++) {
        const char = remainder[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\' && inString) {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        // Only count braces outside of strings
        if (!inString) {
          if (char === '{') {
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = i;
              break;
            }
          }
        }
      }

      if (endIdx === -1) {
        break;
      }

      extracted.push(remainder.substring(startIdx, endIdx + 1));
      remainder = remainder.substring(endIdx + 1);
    }

    return { extracted, remainder };
  }

  normalizeEmbeddedToolCallChunk(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return data;
    }

    const hasToolCallIdentity =
      (typeof data.name === 'string' || typeof data.tool === 'string') &&
      (typeof data.id === 'string' || typeof data.toolCallId === 'string');
    const isDirectToolCall =
      (data.type === 'tool_call' || data.type === 'tool_start') && hasToolCallIdentity;
    const isDirectToolResult =
      (data.type === 'tool_result' || data.type === 'tool_end' || data.type === 'tool_error') &&
      (typeof data.id === 'string' || typeof data.toolCallId === 'string') &&
      (data.output !== undefined || data.error !== undefined);
    if (isDirectToolCall || isDirectToolResult) {
      return data;
    }

    const content =
      typeof data.content === 'string'
        ? data.content.trim()
        : typeof data.message === 'string'
          ? data.message.trim()
          : '';

    if (!content || content[0] !== '{') {
      return data;
    }

    try {
      const embedded = JSON.parse(content);
      const embeddedType = embedded?.type;
      const embeddedToolCall =
        (embeddedType === 'tool_call' || embeddedType === 'tool_start') &&
        typeof (embedded.name || embedded.tool) === 'string' &&
        (typeof embedded.id === 'string' || typeof embedded.toolCallId === 'string');
      const embeddedToolResult =
        (embeddedType === 'tool_result' || embeddedType === 'tool_end' || embeddedType === 'tool_error') &&
        (typeof embedded.id === 'string' || typeof embedded.toolCallId === 'string');

      if (embedded && typeof embedded === 'object' && !Array.isArray(embedded) && (embeddedToolCall || embeddedToolResult)) {
        return {
          ...data,
          ...embedded,
          type: embeddedType,
          content: embedded.content,
          arguments: embedded.arguments ?? embedded.args ?? embedded.input,
          __embeddedToolCallSource: data,
        };
      }
    } catch {
      return data;
    }

    return data;
  }

  /**
   * Parse an n8n response chunk and extract content and turn boundary info.
   * Handles JSON chunks with various content fields (content, text, output, message)
   * and detects agent turn boundaries (type: "end") in a single parse.
   * @param {string} chunkText - Raw chunk text (JSON or plain text)
   * @returns {{ content: string|null, isEndOfTurn: boolean, toolCallStart: object|null, toolCallEnd: object|null, raw: object|null }} Parsed result
   */
  parseN8nChunk(chunkText) {
    if (!chunkText || !chunkText.trim()) {
      return { content: null, isEndOfTurn: false, toolCallStart: null, toolCallEnd: null, raw: null };
    }

    try {
      const data = JSON.parse(chunkText);
      const normalizedData = this.normalizeEmbeddedToolCallChunk(data);

      const isEndOfTurn = normalizedData.type === 'end';
      const toolCallStart = this.extractToolCallStart(normalizedData);
      const toolCallEnd = this.extractToolCallEnd(normalizedData);

      // Skip metadata chunks (but still report turn boundaries)
      if (normalizedData.type && N8nClient.METADATA_TYPES.has(normalizedData.type)) {
        return { content: null, isEndOfTurn, toolCallStart, toolCallEnd, raw: normalizedData };
      }

      // Tool-result payloads are lifecycle data, not assistant prose. Keeping
      // their output out of `content` prevents it leaking after the completion
      // event has already populated LibreChat's native tool-call card.
      const content = toolCallEnd || toolCallStart
        ? null
        : normalizedData.content || normalizedData.text || normalizedData.output || normalizedData.message || null;
      return { content, isEndOfTurn, toolCallStart, toolCallEnd, raw: normalizedData };
    } catch {
      // Not JSON, return as plain text
      const stripped = chunkText.trim();
      const content = stripped.startsWith('{') ? null : stripped;
      return { content, isEndOfTurn: false, toolCallStart: null, toolCallEnd: null, raw: null };
    }
  }

  extractToolCallStart(data) {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const type = typeof data.type === 'string' ? data.type : '';
    const name = typeof data.name === 'string' ? data.name : typeof data.tool === 'string' ? data.tool : '';
    const id = typeof data.id === 'string' ? data.id : typeof data.toolCallId === 'string' ? data.toolCallId : '';
    const args = data.arguments ?? data.args ?? data.input ?? '';

    if ((type === 'tool_call' || type === 'tool_start') && name && id) {
      return { id, name, args };
    }

    return null;
  }

  extractToolCallEnd(data) {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const type = typeof data.type === 'string' ? data.type : '';
    if (type !== 'tool_result' && type !== 'tool_end' && type !== 'tool_error') {
      return null;
    }

    const output = Array.isArray(data.output) && data.output.length === 0
      ? ''
      : typeof data.output === 'string'
        ? data.output
        : data.output !== undefined
          ? JSON.stringify(data.output)
          : typeof data.content === 'string'
            ? data.content
            : typeof data.message === 'string'
              ? data.message
              : '';

    return {
      id:
        typeof data.id === 'string'
          ? data.id
          : typeof data.toolCallId === 'string'
            ? data.toolCallId
            : '',
      name: typeof data.name === 'string' ? data.name : typeof data.tool === 'string' ? data.tool : '',
      error:
        typeof data.error === 'string'
          ? data.error
          : data.error && typeof data.error.message === 'string'
            ? data.error.message
            : typeof data.message === 'string' && type === 'tool_error'
              ? data.message
              : '',
      output,
    };
  }

  extractRuntimeToolCallStart(response, runId = '') {
    const runtime = response?.data?.runtime;
    if (!runtime || typeof runtime !== 'object') {
      return null;
    }

    const candidateName =
      typeof runtime.toolName === 'string'
        ? runtime.toolName
        : typeof runtime.tool === 'string'
          ? runtime.tool
          : typeof runtime.name === 'string'
            ? runtime.name
            : '';

    if (!candidateName) {
      return null;
    }

    const candidateArgs = runtime.toolArgs ?? runtime.arguments ?? runtime.args ?? runtime.input ?? '';
    const candidateId =
      typeof runtime.toolCallId === 'string' && runtime.toolCallId
        ? runtime.toolCallId
        : buildSyntheticToolCallId(runId, response?.data?.runtimeRunId, response?.data?.runId, candidateName);

    return {
      id: candidateId,
      name: candidateName,
      args: candidateArgs,
    };
  }
}

function createToolCallTextFilter(maxBufferSize) {
  const stripToolCallLogText = createToolCallLogTextFilter(maxBufferSize);
  const stripToolCallJson = createEmbeddedToolCallJsonFilter(maxBufferSize);

  return (content = '', flush = false) =>
    stripToolCallJson(stripToolCallLogText(content, flush), flush);
}

function createEmbeddedToolCallJsonFilter(maxBufferSize) {
  let pending = '';

  return (content = '', flush = false) => {
    let input = pending + (typeof content === 'string' ? content : '');
    pending = '';
    let text = '';
    const toolCalls = [];

    while (input) {
      const start = input.indexOf('{');
      if (start < 0) {
        text += input;
        break;
      }
      text += input.slice(0, start);

      const end = findJsonObjectEnd(input, start);
      if (end < 0) {
        if (flush) {
          text += input.slice(start);
        } else {
          pending = input.slice(start);
          if (pending.length > maxBufferSize) {
            throw new Error(`Incomplete tool-call text exceeded maximum size of ${maxBufferSize} bytes`);
          }
        }
        break;
      }

      const json = input.slice(start, end + 1);
      input = input.slice(end + 1);
      let candidate;
      try {
        candidate = JSON.parse(json);
      } catch {
        text += json;
        continue;
      }

      const isToolCall =
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        (candidate.type === 'tool_call' || candidate.type === 'tool_start') &&
        typeof (candidate.name || candidate.tool) === 'string' &&
        (typeof candidate.id === 'string' || typeof candidate.toolCallId === 'string');
      if (isToolCall) {
        toolCalls.push(candidate);
      } else {
        text += json;
      }
    }

    return { text, toolCalls };
  };
}

function createToolCallLogTextFilter(maxBufferSize) {
  const marker = 'Calling ';
  const separator = ' with input: ';
  let pending = '';

  return (content = '', flush = false) => {
    let input = pending + (typeof content === 'string' ? content : '');
    pending = '';
    let text = '';

    while (input) {
      const markerIndex = input.indexOf(marker);
      if (markerIndex < 0) {
        if (flush) {
          text += input;
          break;
        }

        let keepLength = 0;
        const maxSuffixLength = Math.min(marker.length - 1, input.length);
        for (let length = 1; length <= maxSuffixLength; length += 1) {
          if (marker.startsWith(input.slice(-length))) {
            keepLength = length;
          }
        }
        text += input.slice(0, input.length - keepLength);
        pending = input.slice(input.length - keepLength);
        break;
      }

      text += input.slice(0, markerIndex);
      const separatorIndex = input.indexOf(separator, markerIndex + marker.length);
      if (separatorIndex < 0) {
        const candidate = input.slice(markerIndex);
        if (!flush && candidate.length <= maxBufferSize) {
          pending = candidate;
          break;
        }
        text += candidate;
        break;
      }

      const toolName = input.slice(markerIndex + marker.length, separatorIndex).trim();
      const jsonStart = separatorIndex + separator.length;
      if (toolName && jsonStart === input.length && !flush) {
        pending = input.slice(markerIndex);
        break;
      }
      if (!toolName || input[jsonStart] !== '{') {
        text += input.slice(markerIndex, jsonStart);
        input = input.slice(jsonStart);
        continue;
      }

      const jsonEnd = findJsonObjectEnd(input, jsonStart);
      if (jsonEnd < 0) {
        const candidate = input.slice(markerIndex);
        if (!flush && candidate.length <= maxBufferSize) {
          pending = candidate;
        } else {
          text += candidate;
        }
        break;
      }

      let args;
      try {
        args = JSON.parse(input.slice(jsonStart, jsonEnd + 1));
      } catch {
        args = null;
      }

      if (args && typeof args === 'object' && !Array.isArray(args)) {
        input = input.slice(jsonEnd + 1);
      } else {
        text += input.slice(markerIndex, jsonEnd + 1);
        input = input.slice(jsonEnd + 1);
      }
    }

    return text;
  };
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
  }

  return -1;
}

function buildSyntheticToolCallId(runId, runtimeRunId, responseRunId, candidateName) {
  const baseId =
    typeof runId === 'string' && runId
      ? runId
      : typeof runtimeRunId === 'string' && runtimeRunId
        ? runtimeRunId
        : typeof responseRunId === 'string' && responseRunId
          ? responseRunId
          : 'runtime';

  return `synthetic_${baseId}_${candidateName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

module.exports = N8nClient;
