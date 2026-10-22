const {
  PREFIX,
  SUFFIX,
  encodeLibreChatStepEvent,
  createLibreChatStepEventDecoder,
} = require('../../src/utils/libreChatEventProtocol');

describe('LibreChat sideband event protocol', () => {
  const event = {
    event: 'on_run_step',
    data: { id: 'step-1', runId: 'response-1', stepDetails: { type: 'tool_calls' } },
  };

  test('encodes one lifecycle payload into ordinary text and decodes it', () => {
    const encoded = encodeLibreChatStepEvent(event);
    expect(encoded.startsWith(PREFIX)).toBe(true);
    expect(encoded.endsWith(SUFFIX)).toBe(true);

    const decoder = createLibreChatStepEventDecoder();
    expect(decoder.push(`answer ${encoded} done`)).toEqual([
      { type: 'text', text: 'answer ' },
      { type: 'event', event },
      { type: 'text', text: ' done' },
    ]);
  });

  test('handles a marker split over arbitrary content chunks', () => {
    const encoded = encodeLibreChatStepEvent(event);
    const splitAt = Math.floor(encoded.length / 2);
    const decoder = createLibreChatStepEventDecoder();

    expect(decoder.push(`before ${encoded.slice(0, splitAt)}`)).toEqual([
      { type: 'text', text: 'before ' },
    ]);
    expect(decoder.push(`${encoded.slice(splitAt)} after`)).toEqual([
      { type: 'event', event },
      { type: 'text', text: ' after' },
    ]);
  });

  test('preserves malformed control-like content instead of swallowing it', () => {
    const decoder = createLibreChatStepEventDecoder();
    const malformed = `${PREFIX}not-base64-json${SUFFIX}`;
    expect(decoder.push(malformed)).toEqual([{ type: 'text', text: malformed }]);
  });

  test('rejects event types outside the step lifecycle allowlist', () => {
    expect(() => encodeLibreChatStepEvent({ event: 'title', data: {} })).toThrow(
      'Invalid LibreChat step event',
    );
  });
});
