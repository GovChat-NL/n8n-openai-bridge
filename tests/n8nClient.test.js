const axios = require('axios');

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock axios
jest.mock('axios');

const N8nClient = require('../src/n8nClient');

describe('N8nClient', () => {
  let client;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = {
      n8nBearerToken: '',
    };
    client = new N8nClient(mockConfig);
  });

  describe('getHeaders', () => {
    test('should return headers with Authorization when token is set', () => {
      mockConfig.n8nWebhookBearerToken = 'test-token';

      const headers = client.getHeaders();

      expect(headers).toHaveProperty('Content-Type', 'application/json');
      expect(headers).toHaveProperty('Authorization', 'Bearer test-token');
    });

    test('should return headers without Authorization when token is empty', () => {
      mockConfig.n8nWebhookBearerToken = '';

      const headers = client.getHeaders();

      expect(headers).toHaveProperty('Content-Type', 'application/json');
      expect(headers).not.toHaveProperty('Authorization');
    });
  });

  describe('buildPayload', () => {
    test('should build payload with system prompt and current message', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      const userContext = {
        userId: 'user-456',
        userEmail: 'user@example.com',
        userName: 'John Doe',
        userRole: 'admin',
      };

      const payload = client.buildPayload(messages, 'session-123', userContext);

      expect(payload.systemPrompt).toBe('You are a helpful assistant');
      expect(payload.currentMessage).toBe('How are you?');
      expect(payload.chatInput).toBe('How are you?');
      expect(payload.sessionId).toBe('session-123');
      expect(payload.userId).toBe('user-456');
      expect(payload.userEmail).toBe('user@example.com');
      expect(payload.userName).toBe('John Doe');
      expect(payload.userRole).toBe('admin');
    });

    test('should filter out system messages from messages array', () => {
      const messages = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      const userContext = { userId: 'user-456' };
      const payload = client.buildPayload(messages, 'session-123', userContext);

      expect(payload.messages).toHaveLength(2);
      expect(payload.messages.every((m) => m.role !== 'system')).toBe(true);
    });

    test('should handle empty messages array', () => {
      const userContext = { userId: 'user-456' };
      const payload = client.buildPayload([], 'session-123', userContext);

      expect(payload.systemPrompt).toBe('');
      expect(payload.currentMessage).toBe('');
      expect(payload.messages).toEqual([]);
    });

    test('should only include userId when other user fields are null', () => {
      const messages = [{ role: 'user', content: 'Hello' }];

      const userContext = {
        userId: 'user-456',
        userEmail: null,
        userName: null,
        userRole: null,
      };

      const payload = client.buildPayload(messages, 'session-123', userContext);

      expect(payload.userId).toBe('user-456');
      expect(payload).not.toHaveProperty('userEmail');
      expect(payload).not.toHaveProperty('userName');
      expect(payload).not.toHaveProperty('userRole');
    });

    test('should include only provided optional user fields', () => {
      const messages = [{ role: 'user', content: 'Hello' }];

      const userContext = {
        userId: 'user-456',
        userEmail: 'user@example.com',
        userName: null,
        userRole: 'admin',
      };

      const payload = client.buildPayload(messages, 'session-123', userContext);

      expect(payload.userId).toBe('user-456');
      expect(payload.userEmail).toBe('user@example.com');
      expect(payload).not.toHaveProperty('userName');
      expect(payload.userRole).toBe('admin');
    });
  });

  describe('nonStreamingCompletion', () => {
    test('should collect and return complete streamed response', async () => {
      // Mock a stream response from n8n
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{"type":"begin","metadata":{}}');
          yield Buffer.from('{"type":"item","content":"Hello "}');
          yield Buffer.from('{"type":"item","content":"World"}');
          yield Buffer.from('{"type":"end","metadata":{}}');
        },
      };

      axios.post.mockResolvedValue({
        data: mockStream,
      });

      const userContext = { userId: 'user-456' };
      const result = await client.nonStreamingCompletion(
        'https://n8n.example.com/webhook/test/chat',
        [{ role: 'user', content: 'Hello' }],
        'session-123',
        userContext,
      );

      expect(result).toBe('Hello World');
    });

    test('should handle single chunk response', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{"type":"item","content":"Complete response"}');
          yield Buffer.from('{"type":"end"}');
        },
      };

      axios.post.mockResolvedValue({
        data: mockStream,
      });

      const userContext = { userId: 'user-456' };
      const result = await client.nonStreamingCompletion(
        'https://n8n.example.com/webhook/test/chat',
        [{ role: 'user', content: 'Hello' }],
        'session-123',
        userContext,
      );

      expect(result).toBe('Complete response');
    });

    test('should handle response with different content fields', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{"output":"Part 1 "}');
          yield Buffer.from('{"text":"Part 2 "}');
          yield Buffer.from('{"message":"Part 3"}');
        },
      };

      axios.post.mockResolvedValue({
        data: mockStream,
      });

      const userContext = { userId: 'user-456' };
      const result = await client.nonStreamingCompletion(
        'https://n8n.example.com/webhook/test/chat',
        [{ role: 'user', content: 'Hello' }],
        'session-123',
        userContext,
      );

      expect(result).toBe('Part 1 Part 2 Part 3');
    });

    test('should handle errors gracefully', async () => {
      axios.post.mockRejectedValue(new Error('Network error'));

      const userContext = { userId: 'user-456' };
      await expect(
        client.nonStreamingCompletion(
          'https://n8n.example.com/webhook/test/chat',
          [{ role: 'user', content: 'Hello' }],
          'session-123',
          userContext,
        ),
      ).rejects.toThrow('Network error');
    });
  });

  describe('processResponseStream', () => {
    test('should emit a LibreChat run step before streamed answer text when a tool starts', async () => {
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(
              '{"type":"tool_call","id":"call_wait_1","name":"wait_test_tool","arguments":{"delayMs":3000}}\n',
            );
            yield Buffer.from('{"content":"Ik ga nu wachten."}\n');
            yield Buffer.from(
              '{"type":"tool_result","id":"call_wait_1","output":"wachten gelukt"}\n',
            );
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse, { runId: 'resp-123' })) {
        chunks.push(content);
      }

      expect(chunks[0]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step',
          data: {
            id: 'step_call_wait_1',
            index: 0,
            runId: 'resp-123',
            status: 'in_progress',
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [
                {
                  id: 'call_wait_1',
                  type: 'tool_call',
                  name: 'wait_test_tool',
                  args: { delayMs: 3000 },
                },
              ],
            },
          },
        },
      });
      expect(chunks[1]).toBe('Ik ga nu wachten.');
      expect(chunks[2]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step_completed',
          data: {
            result: {
              id: 'step_call_wait_1',
              completed_at: expect.any(Number),
              tool_call: {
                id: 'call_wait_1',
                type: 'tool_call',
                name: 'wait_test_tool',
                args: { delayMs: 3000 },
                output: 'wachten gelukt',
                progress: 1,
              },
            },
          },
        },
      });
      expect(chunks[3]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step_closed',
          data: {
            id: 'step_call_wait_1',
            status: 'completed',
            completed_at: expect.any(Number),
          },
        },
      });
    });

    test('should assign increasing LibreChat indices to sequential tool calls', async () => {
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(
              '{"type":"tool_call","id":"call_first","name":"first_tool","arguments":{}}\n',
            );
            yield Buffer.from('{"type":"tool_result","id":"call_first","output":"first"}\n');
            yield Buffer.from(
              '{"type":"tool_call","id":"call_second","name":"second_tool","arguments":{}}\n',
            );
            yield Buffer.from('{"type":"tool_result","id":"call_second","output":"second"}\n');
          },
        },
      };

      const stepIndices = [];
      for await (const content of client.processResponseStream(mockResponse, { runId: 'resp-123' })) {
        if (content?.kind === 'librechat_step_event' && content.payload.event === 'on_run_step') {
          stepIndices.push(content.payload.data.index);
        }
      }

      expect(stepIndices).toEqual([0, 1]);
    });

    test('should preserve whitespace in JSON content fields', async () => {
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"content":"Hello "}');
            yield Buffer.from('{"content":"\\n\\nWorld"}');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks).toEqual(['Hello ', '\n\nWorld']);
    });

    test('should preserve whitespace between agent turns in streaming', async () => {
      // Simulates n8n sending content from different agent turns
      // where trailing newlines separate paragraphs
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"content":"First paragraph.\\n\\n"}');
            yield Buffer.from('{"content":"Second paragraph."}');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks.join('')).toBe('First paragraph.\n\nSecond paragraph.');
    });

    test('should inject separator between agent turns at end/begin boundaries', async () => {
      // Simulates n8n AI Agent sending end/begin markers between tool calls
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"First turn text."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Second turn text."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks.join('')).toBe('First turn text.\n\nSecond turn text.');
    });

    test('should not inject separator before the first agent turn', async () => {
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Only turn."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks.join('')).toBe('Only turn.');
    });

    test('should inject separator across multiple agent turns', async () => {
      // Simulates 3 agent turns with tool calls in between
      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Turn 1."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Turn 2."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Turn 3."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks.join('')).toBe('Turn 1.\n\nTurn 2.\n\nTurn 3.');
    });

    test.each([
      [' --- ', 'Turn 1. --- Turn 2.', 'custom text'],
      ['', 'Turn 1.Turn 2.', 'empty (disabled)'],
      ['\n', 'Turn 1.\nTurn 2.', 'single newline'],
    ])('should use configurable separator: %s (%s)', async (separator, expected) => {
      mockConfig.agentTurnSeparator = separator;
      const customClient = new N8nClient(mockConfig);

      const mockResponse = {
        data: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Turn 1."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
            yield Buffer.from('{"type":"begin","metadata":{}}\n');
            yield Buffer.from('{"type":"item","content":"Turn 2."}\n');
            yield Buffer.from('{"type":"end","metadata":{}}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of customClient.processResponseStream(mockResponse)) {
        chunks.push(content);
      }

      expect(chunks.join('')).toBe(expected);
    });
  });

  describe('extractJsonChunks', () => {
    test('should extract single JSON object', () => {
      const buffer = '{"content":"Hello"}';
      const result = client.extractJsonChunks(buffer);

      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('{"content":"Hello"}');
      expect(result.remainder).toBe('');
    });

    test('should extract multiple JSON objects', () => {
      const buffer = '{"content":"Hello"}{"content":"World"}';
      const result = client.extractJsonChunks(buffer);

      expect(result.extracted).toHaveLength(2);
      expect(result.extracted[0]).toBe('{"content":"Hello"}');
      expect(result.extracted[1]).toBe('{"content":"World"}');
    });

    test('should handle nested JSON objects', () => {
      const buffer = '{"data":{"nested":"value"}}';
      const result = client.extractJsonChunks(buffer);

      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('{"data":{"nested":"value"}}');
    });

    test('should keep incomplete JSON in remainder', () => {
      const buffer = '{"content":"Hello"}{"incomplete":';
      const result = client.extractJsonChunks(buffer);

      expect(result.extracted).toHaveLength(1);
      expect(result.remainder).toBe('{"incomplete":');
    });

    test('should handle buffer with no JSON', () => {
      const buffer = 'plain text';
      const result = client.extractJsonChunks(buffer);

      expect(result.extracted).toHaveLength(0);
      expect(result.remainder).toBe('plain text');
    });
  });

  describe('parseN8nChunk', () => {
    test('should extract content from JSON chunk', () => {
      const chunk = '{"content":"Hello world"}';
      const result = client.parseN8nChunk(chunk);

      expect(result).toEqual({
        content: 'Hello world',
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { content: 'Hello world' },
      });
    });

    test('should extract text from JSON chunk', () => {
      const chunk = '{"text":"Hello world"}';
      const result = client.parseN8nChunk(chunk);

      expect(result).toEqual({
        content: 'Hello world',
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { text: 'Hello world' },
      });
    });

    test('should extract output from JSON chunk', () => {
      const chunk = '{"output":"Hello world"}';
      const result = client.parseN8nChunk(chunk);

      expect(result).toEqual({
        content: 'Hello world',
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { output: 'Hello world' },
      });
    });

    test('should skip metadata chunks', () => {
      const chunk = '{"type":"metadata","data":"ignored"}';
      const result = client.parseN8nChunk(chunk);

      expect(result).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { type: 'metadata', data: 'ignored' },
      });
    });

    test('should skip begin/error chunks without end-of-turn signal', () => {
      expect(client.parseN8nChunk('{"type":"begin"}')).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { type: 'begin' },
      });
      expect(client.parseN8nChunk('{"type":"error"}')).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { type: 'error' },
      });
    });

    test('should detect end-of-turn on end chunks', () => {
      expect(client.parseN8nChunk('{"type":"end"}')).toEqual({
        content: null,
        isEndOfTurn: true,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { type: 'end' },
      });
      expect(client.parseN8nChunk('{"type":"end","metadata":{}}')).toEqual({
        content: null,
        isEndOfTurn: true,
        toolCallStart: null,
        toolCallEnd: null,
        raw: { type: 'end', metadata: {} },
      });
    });

    test('should handle plain text', () => {
      const result = client.parseN8nChunk('plain text');

      expect(result).toEqual({
        content: 'plain text',
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: null,
      });
    });

    test('should return null content for empty input', () => {
      expect(client.parseN8nChunk('')).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: null,
      });
      expect(client.parseN8nChunk('   ')).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: null,
      });
    });

    test('should return null content for invalid JSON starting with brace', () => {
      const result = client.parseN8nChunk('{invalid json}');

      expect(result).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: null,
      });
    });

    test('should detect tool call start chunks', () => {
      const result = client.parseN8nChunk(
        '{"type":"tool_call","id":"call_wait_1","name":"wait_test_tool","arguments":{"delayMs":250}}',
      );

      expect(result).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: {
          id: 'call_wait_1',
          name: 'wait_test_tool',
          args: { delayMs: 250 },
        },
        toolCallEnd: null,
        raw: {
          type: 'tool_call',
          id: 'call_wait_1',
          name: 'wait_test_tool',
          arguments: { delayMs: 250 },
        },
      });
    });

    test('should detect tool call end chunks', () => {
      const result = client.parseN8nChunk(
        '{"type":"tool_result","output":"wait complete"}',
      );

      expect(result).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: {
          id: '',
          output: 'wait complete',
        },
        raw: {
          type: 'tool_result',
          output: 'wait complete',
        },
      });
    });

    test('should detect tool call end chunks with tool call id', () => {
      const result = client.parseN8nChunk(
        '{"type":"tool_result","id":"call_wait_1","output":"wait complete"}',
      );

      expect(result).toEqual({
        content: null,
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: {
          id: 'call_wait_1',
          output: 'wait complete',
        },
        raw: {
          type: 'tool_result',
          id: 'call_wait_1',
          output: 'wait complete',
        },
      });
    });

    test('should preserve raw payload for synthetic tool-step detection candidates', () => {
      const result = client.parseN8nChunk(
        '{"toolName":"wait_test_tool","toolArgs":{"delayMs":250},"message":"Ik ga wachten."}',
      );

      expect(result).toEqual({
        content: 'Ik ga wachten.',
        isEndOfTurn: false,
        toolCallStart: null,
        toolCallEnd: null,
        raw: {
          toolName: 'wait_test_tool',
          toolArgs: { delayMs: 250 },
          message: 'Ik ga wachten.',
        },
      });
    });
  });

  describe('synthetic early tool step emission', () => {
    test('should synthesize a LibreChat run step before answer text from runtime tool metadata', async () => {
      const mockResponse = {
        data: {
          runtime: {
            toolName: 'wait_test_tool',
            toolArgs: { delayMs: 3000 },
          },
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"message":"Ik ga nu wachten."}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse, { runId: 'resp-456' })) {
        chunks.push(content);
      }

      expect(chunks[0]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step',
          data: {
            id: 'step_synthetic_resp-456_wait_test_tool',
            index: 0,
            runId: 'resp-456',
            status: 'in_progress',
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [
                {
                  id: 'synthetic_resp-456_wait_test_tool',
                  type: 'tool_call',
                  name: 'wait_test_tool',
                  args: { delayMs: 3000 },
                },
              ],
            },
          },
        },
      });
      expect(chunks[1]).toBe('Ik ga nu wachten.');
      expect(chunks[2]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step_completed',
          data: {
            result: {
              id: 'step_synthetic_resp-456_wait_test_tool',
              completed_at: expect.any(Number),
              tool_call: {
                id: 'synthetic_resp-456_wait_test_tool',
                type: 'tool_call',
                name: 'wait_test_tool',
                args: { delayMs: 3000 },
                output: '',
                progress: 1,
              },
            },
          },
        },
      });
      expect(chunks[3]).toEqual({
        kind: 'librechat_step_event',
        payload: {
          event: 'on_run_step_closed',
          data: {
            id: 'step_synthetic_resp-456_wait_test_tool',
            status: 'completed',
            completed_at: expect.any(Number),
          },
        },
      });
    });

    test('should prefer runtime toolCallId when provided', async () => {
      const mockResponse = {
        data: {
          runtime: {
            toolCallId: 'runtime-call-123',
            toolName: 'wait_test_tool',
            toolArgs: { delayMs: 1500 },
          },
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"message":"Ik ga nu wachten."}\n');
          },
        },
      };

      const chunks = [];
      for await (const content of client.processResponseStream(mockResponse, { runId: 'resp-789' })) {
        chunks.push(content);
      }

      expect(chunks[0]).toEqual(
        expect.objectContaining({
          kind: 'librechat_step_event',
          payload: expect.objectContaining({
            event: 'on_run_step',
            data: expect.objectContaining({
              id: 'step_runtime-call-123',
              runId: 'resp-789',
              stepDetails: {
                type: 'tool_calls',
                tool_calls: [
                  {
                    id: 'runtime-call-123',
                    type: 'tool_call',
                    name: 'wait_test_tool',
                    args: { delayMs: 1500 },
                  },
                ],
              },
            }),
          }),
        }),
      );
      expect(chunks[2]).toEqual(
        expect.objectContaining({
          kind: 'librechat_step_event',
          payload: expect.objectContaining({
            event: 'on_run_step_completed',
            data: {
              result: expect.objectContaining({
                id: 'step_runtime-call-123',
                tool_call: expect.objectContaining({
                  id: 'runtime-call-123',
                }),
              }),
            },
          }),
        }),
      );
    });
  });
});
