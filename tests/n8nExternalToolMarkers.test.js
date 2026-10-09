const {
  extractExternalToolMarkers,
  normalizeExternalToolMarker,
} = require('../src/utils/n8nExternalToolMarkers');

describe('n8n external-tool marker parser', () => {
  test('removes a trusted marker and creates an OpenAI-compatible tool call', () => {
    const marker = JSON.stringify({
      version: 1,
      id: 'call_simplify',
      name: 'simplify_to_b1',
      arguments: { text: 'Complexe tekst' },
    });

    expect(extractExternalToolMarkers(`Voor ${`<!--GOVCHAT_EXTERNAL_TOOL:${marker}-->`} na`)).toEqual({
      content: 'Voor  na',
      toolCalls: [
        {
          id: 'call_simplify',
          type: 'function',
          function: {
            name: 'simplify_to_b1',
            arguments: '{"text":"Complexe tekst"}',
          },
        },
      ],
    });
  });

  test('keeps plain assistant text unchanged', () => {
    expect(extractExternalToolMarkers('Normaal antwoord')).toEqual({
      content: 'Normaal antwoord',
      toolCalls: [],
    });
  });

  test('does not create a tool call from malformed marker data', () => {
    expect(extractExternalToolMarkers('<!--GOVCHAT_EXTERNAL_TOOL:{not json}-->')).toEqual({
      content: '',
      toolCalls: [],
    });
    expect(normalizeExternalToolMarker({ id: 'call_a' })).toBeNull();
  });
});
