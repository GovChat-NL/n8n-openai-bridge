const { handleStreaming } = require('../../src/handlers/streamingHandler');
const { createLibreChatStepEventDecoder } = require('../../src/utils/libreChatEventProtocol');

function createResponse() {
  const writes = [];
  return {
    writes,
    req: { id: 'request-1' },
    setHeader: jest.fn(),
    write: (chunk) => writes.push(chunk),
    end: jest.fn(),
  };
}

describe('handleStreaming LibreChat lifecycle sideband', () => {
  test('wraps lifecycle events as normal OpenAI content and leaves text as text', async () => {
    const event = {
      event: 'on_run_step',
      data: { id: 'step-1', runId: 'response-1', stepDetails: { type: 'tool_calls' } },
    };
    const n8nClient = {
      async *streamCompletion() {
        yield { kind: 'librechat_step_event', payload: event };
        yield 'answer';
      },
    };
    const res = createResponse();

    await handleStreaming(res, n8nClient, '/webhook', [], 'session-1', {}, 'model-1', {}, 'run-1');

    const frames = res.writes
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice('data: '.length).split('\n')[0]));
    expect(res.writes.filter((frame) => frame.startsWith('event:')).every((frame) => frame === 'event: message\n')).toBe(true);
    const lifecycleContent = frames[0].choices[0].delta.content;
    const decoder = createLibreChatStepEventDecoder();
    expect(decoder.push(lifecycleContent)).toEqual([{ type: 'event', event }]);
    expect(frames[1].choices[0].delta.content).toBe('answer');
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
