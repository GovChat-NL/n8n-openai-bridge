/**
 * Essential Entra identity boundary tests (generated fixtures; no live services).
 * Copyright (c) 2025 Sven Eisenschmidt
 * Licensed under AGPL-3.0
 */

const { generateKeyPairSync, randomUUID, sign } = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');
const axios = require('axios');
const Config = require('../../src/config/Config');
const N8nClient = require('../../src/n8nClient');
const authenticate = require('../../src/middleware/authenticate');
const requestLogger = require('../../src/middleware/requestLogger');
const chatRoute = require('../../src/routes/chatCompletions');
const {
  readEntraConfig,
  createEntraIdentity,
  identityContext,
  deniedIdentity,
} = require('../../src/middleware/entraIdentity');

jest.mock('axios');
const tenant = randomUUID();
const appId = randomUUID(); // API and login application deliberately share an ID.
const group = randomUUID();
const pairs = [0, 1].map(() => generateKeyPairSync('rsa', { modulusLength: 2048 }));
const jwks = pairs.map((pair, index) => ({
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: `key-${index}`,
}));
const env = {
  ENTRA_JWT_ENABLED: 'true',
  ENTRA_TENANT_ID: tenant,
  ENTRA_EXPECTED_AUDIENCE: appId,
  ENTRA_ALLOWED_CLIENT_ID: appId,
  ENTRA_REQUIRED_SCOPE: 'access_as_user',
  BEARER_TOKEN: 'inbound-generated-fixture',
  N8N_WEBHOOK_BEARER_TOKEN: 'outbound-generated-fixture',
};
const settings = readEntraConfig(env);
function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ver: '2.0',
    tid: tenant,
    iss: settings.issuer,
    aud: appId,
    azp: appId,
    scp: 'openid access_as_user',
    oid: randomUUID(),
    sub: 'generated-user',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 600,
    groups: [group],
    ...overrides,
  };
}
function jwt(payload = claims(), header = {}, signer = 0) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: `key-${signer}`, ...header })}.${encode(payload)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pairs[signer].privateKey).toString('base64url')}`;
}
function keyResponse(keys = jwks) {
  return { ok: true, text: async () => JSON.stringify({ keys }) };
}
async function invoke(middleware, token, body = {}) {
  const req = { headers: token === undefined ? {} : { [settings.header]: token }, body };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await middleware(req, res, next);
  return { req, res, next };
}
function fakeBody() {
  const fake = {
    user_authorization_verified: true,
    user_authorization_mode: 'entra_delegated',
    user_authorized_groups: [group],
    user_tid: tenant,
    user_oid: group,
    user_sub: 'forged',
    user_token_expires_at: 9999999999,
    groups: [group],
    userAuthorizationVerified: true,
    tid: tenant,
    oid: group,
    sub: 'forged',
    exp: 9999999999,
    access_token: 'body-credential',
  };
  return {
    ...fake,
    user_role: 'admin',
    metadata: { ...fake },
    extra_args: { ...fake },
    messages: [{ role: 'user', content: 'hello', variables: { ...fake } }],
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('enabled configuration requires exact tenant v2 settings and both non-placeholder bearer tokens', () => {
  for (const name of [
    'ENTRA_TENANT_ID',
    'ENTRA_EXPECTED_AUDIENCE',
    'ENTRA_ALLOWED_CLIENT_ID',
    'ENTRA_REQUIRED_SCOPE',
    'BEARER_TOKEN',
    'N8N_WEBHOOK_BEARER_TOKEN',
  ]) {
    expect(() => readEntraConfig({ ...env, [name]: '' })).toThrow();
  }
  for (const override of [
    { BEARER_TOKEN: 'your-api-key' },
    { N8N_WEBHOOK_BEARER_TOKEN: 'replace-me' },
    { ENTRA_EXPECTED_AUDIENCE: `api://${appId}` },
    { ENTRA_REQUIRED_SCOPE: `api://${appId}/access_as_user` },
    { ENTRA_EXPECTED_ISSUER: 'https://login.microsoftonline.com/common/v2.0' },
    { ENTRA_ACCESS_TOKEN_HEADER: 'Authorization' },
    { ENTRA_JWT_ENABLED: 'yes' },
  ]) {
    expect(() => readEntraConfig({ ...env, ...override })).toThrow();
  }
  expect(readEntraConfig({})).toEqual({ enabled: false, header: settings.header });
  expect(readEntraConfig({ ...env, ENTRA_EXPECTED_ISSUER: settings.issuer })).toEqual(settings);
});

test('accepts same-app delegated RSA token into immutable context, never client identity', async () => {
  const payload = claims();
  const fetchKeys = jest.fn().mockResolvedValue(keyResponse());
  const result = await invoke(createEntraIdentity(settings, fetchKeys), jwt(payload), fakeBody());
  expect(result.next).toHaveBeenCalledTimes(1);
  expect(result.req[identityContext]).toEqual({
    user_authorization_verified: true,
    user_authorization_mode: 'entra_delegated',
    user_authorized_groups: [group],
    user_tid: tenant,
    user_oid: payload.oid,
    user_sub: payload.sub,
    user_token_expires_at: payload.exp,
  });
  expect(Object.isFrozen(result.req[identityContext])).toBe(true);
  expect(Object.isFrozen(result.req[identityContext].user_authorized_groups)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(result.req, identityContext).writable).toBe(false);
  expect(fetchKeys).toHaveBeenCalledWith(
    `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
    expect.objectContaining({ redirect: 'error', signal: expect.any(globalThis.AbortSignal) }),
  );
  expect(result.req.headers).toEqual({});
});

test('rejects invalid signature, claims, ID/app-only tokens, algorithms and malformed input', async () => {
  const now = Math.floor(Date.now() / 1000);
  const middleware = createEntraIdentity(settings, jest.fn().mockResolvedValue(keyResponse()));
  const invalid = [
    ...[
      { exp: now - 1 },
      { exp: '9999999999' },
      { exp: undefined },
      { nbf: now + 120 },
      { iat: now + 120 },
      { iat: undefined },
      { aud: randomUUID() },
      { aud: [appId] },
      { tid: randomUUID() },
      { iss: `${settings.issuer}/` },
      { iss: 'https://evil.invalid/v2.0' },
      { scp: undefined },
      { scp: 'other_scope' },
      { scp: `api://${appId}/access_as_user` },
      { azp: randomUUID() },
      { azp: undefined },
      { oid: 'admin' },
      { sub: '' },
      { idtyp: 'app' },
      { ver: '1.0' },
      { scp: undefined, roles: ['admin'] },
    ].map((override) => jwt(claims(override))),
    jwt(claims(), { kid: 'key-0' }, 1),
    ...['HS256', 'none', 'RS512'].map((alg) => jwt(claims(), { alg })),
    jwt(claims(), { crit: ['unknown'] }),
    '',
    'a.b.c',
    'Bearer token',
    'a'.repeat(32769),
    `${jwt()}.extra`,
    `${jwt()}=`,
  ];
  for (const token of invalid) {
    const result = await invoke(middleware, token);
    expect(result.res.status).toHaveBeenCalledWith(401);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.req[identityContext]).toBeUndefined();
  }
});

test('missing, malformed and overage group claims grant no groups, regardless of roles', async () => {
  const middleware = createEntraIdentity(settings, jest.fn().mockResolvedValue(keyResponse()));
  for (const override of [
    { groups: undefined },
    { groups: 'admin' },
    { groups: ['admin'] },
    { groups: [null] },
    { groups: Array(201).fill(group) },
    { hasgroups: true },
    {
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://evil.invalid' } },
    },
  ]) {
    const result = await invoke(middleware, jwt(claims({ ...override, roles: ['admin'] })));
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.req[identityContext].user_authorized_groups).toEqual([]);
  }
});

test('absent or disabled tokens preserve ordinary admin presentation but strip all fake identity', async () => {
  const fetchKeys = jest.fn();
  for (const [enabled, token] of [
    [true, undefined],
    [false, jwt()],
    [false, 'invalid'],
  ]) {
    const result = await invoke(
      createEntraIdentity({ ...settings, enabled }, fetchKeys),
      token,
      fakeBody(),
    );
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.req[identityContext]).toEqual(deniedIdentity);
    expect(result.req.body).toEqual({
      user_role: 'admin',
      metadata: {},
      extra_args: {},
      messages: [{ role: 'user', content: 'hello', variables: {} }],
    });
    expect(result.req.headers).toEqual({});
  }
  expect(fetchKeys).not.toHaveBeenCalled();
});

test('real stream/nonstream routes preserve trusted context and never forward/log credential metadata', async () => {
  for (const enabled of [true, false]) {
    const config = new Config();
    Object.assign(config, {
      bearerToken: env.BEARER_TOKEN,
      n8nWebhookBearerToken: env.N8N_WEBHOOK_BEARER_TOKEN,
      entra: { ...settings, enabled, header: 'x-private-entra' },
      logRequests: true,
    });
    const app = express();
    app.locals.config = config;
    app.locals.n8nClient = new N8nClient(config);
    app.locals.modelRepository = { getModelWebhookUrl: () => 'https://workflow.invalid/chat' };
    app.use(
      express.json(),
      authenticate(config),
      createEntraIdentity(config.entra, async () => keyResponse()),
      requestLogger(config),
    );
    app.use('/v1/chat/completions', chatRoute);
    for (const stream of [false, true]) {
      axios.post.mockResolvedValueOnce({ data: Readable.from(['{"content":"hello"}']) });
      const payload = claims();
      const token = jwt(payload);
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${env.BEARER_TOKEN}`)
        .set('X-Private-Entra', token)
        .set('X-User-Role', 'admin')
        .set('X-User-Id', 'legacy-user')
        .set('X-Session-Id', 'legacy-session')
        .send({ ...fakeBody(), model: 'model', stream, metadata: { 'X-Private-Entra': token } });
      expect(response.status).toBe(200);
      const [, forwarded, options] = axios.post.mock.calls.at(-1);
      expect(forwarded).toMatchObject({
        userId: 'legacy-user',
        userRole: 'admin',
        sessionId: 'legacy-session',
        user_authorization_verified: enabled,
        user_authorized_groups: enabled ? [group] : [],
        user_oid: enabled ? payload.oid : null,
        user_token_expires_at: enabled ? payload.exp : null,
      });
      expect(forwarded.messages[0].variables).toEqual({});
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.N8N_WEBHOOK_BEARER_TOKEN}`,
      });
      expect(JSON.stringify(axios.post.mock.calls)).not.toContain(token);
      expect(JSON.stringify(console.log.mock.calls)).not.toContain(token);
      expect(JSON.stringify(console.error.mock.calls)).not.toContain(token);
    }
  }
  const direct = new N8nClient({}).buildPayload(fakeBody().messages, 'session', {
    userId: 'user',
    ...fakeBody(),
  });
  expect(direct).toMatchObject(deniedIdentity);
});

test('inbound bearer stays mandatory; invalid provided Entra token stops before any webhook', async () => {
  const fetchKeys = jest.fn().mockResolvedValue(keyResponse());
  const app = express();
  const forwarded = jest.fn((_req, res) => res.json({ ok: true }));
  app.use(
    express.json(),
    authenticate({ bearerToken: env.BEARER_TOKEN }),
    createEntraIdentity(settings, fetchKeys),
  );
  app.post('/chat', forwarded);
  for (const bearer of ['', 'wrong']) {
    await request(app)
      .post('/chat')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Entra-Access-Token', jwt())
      .send({})
      .expect(401);
  }
  expect(fetchKeys).not.toHaveBeenCalled();
  await request(app)
    .post('/chat')
    .set('Authorization', `Bearer ${env.BEARER_TOKEN}`)
    .set('X-Entra-Access-Token', 'bad')
    .send({})
    .expect(401);
  expect(forwarded).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  await request(app)
    .post('/chat')
    .set('Authorization', `Bearer ${env.BEARER_TOKEN}`)
    .send({})
    .expect(200);
});

test('JWKS cache bounds rotation/failures and rejects non-RSA keys and fetch-time expiry', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const fetchKeys = jest.fn().mockResolvedValue(keyResponse([jwks[0]]));
  const middleware = createEntraIdentity(settings, fetchKeys);
  await invoke(middleware, jwt());
  await invoke(middleware, jwt());
  for (let index = 0; index < 5; index++) {
    expect(
      (await invoke(middleware, jwt(claims(), { kid: `unknown-${index}` }))).res.status,
    ).toHaveBeenCalledWith(401);
  }
  expect(fetchKeys).toHaveBeenCalledTimes(1);
  now += 31000;
  fetchKeys.mockResolvedValue(keyResponse());
  expect((await invoke(middleware, jwt(claims(), {}, 1))).next).toHaveBeenCalledTimes(1);
  now += 3600001;
  expect((await invoke(middleware, jwt())).next).toHaveBeenCalledTimes(1);
  expect(fetchKeys).toHaveBeenCalledTimes(3);
  for (const response of [
    { ok: false },
    keyResponse([{ ...jwks[0], kty: 'EC' }]),
    keyResponse([jwks[0], jwks[0]]),
    keyResponse(Array(101).fill(jwks[0])),
    { ok: true, text: async () => 'invalid' },
    { ok: true, text: async () => 'a'.repeat(131073) },
  ]) {
    const fetchInvalid = jest.fn().mockResolvedValue(response);
    const invalidMiddleware = createEntraIdentity(settings, fetchInvalid);
    expect((await invoke(invalidMiddleware, jwt())).res.status).toHaveBeenCalledWith(401);
    expect((await invoke(invalidMiddleware, jwt())).res.status).toHaveBeenCalledWith(401);
    expect(fetchInvalid).toHaveBeenCalledTimes(1);
  }
  const expires = claims({ exp: Math.floor(now / 1000) + 1 });
  const delayed = createEntraIdentity(settings, async () => {
    now += 2000;
    return keyResponse();
  });
  expect((await invoke(delayed, jwt(expires))).res.status).toHaveBeenCalledWith(401);
});
