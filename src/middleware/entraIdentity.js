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

const { createPublicKey, verify } = require('crypto');
const { sendError } = require('../utils/errorResponse');
const identityContext = Symbol('verified Entra identity');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deniedIdentity = Object.freeze({
  user_authorization_verified: false,
  user_authorization_mode: 'none',
  user_authorized_groups: Object.freeze([]),
  user_tid: null,
  user_oid: null,
  user_sub: null,
  user_token_expires_at: null,
});

/** Parse single-tenant settings and fail closed at startup when enabled. */
function readEntraConfig(env = process.env) {
  if (env.ENTRA_JWT_ENABLED && !['true', 'false'].includes(env.ENTRA_JWT_ENABLED)) {
    throw new Error('Invalid ENTRA_JWT_ENABLED');
  }
  const enabled = env.ENTRA_JWT_ENABLED === 'true';
  const header = (env.ENTRA_ACCESS_TOKEN_HEADER || 'X-Entra-Access-Token').toLowerCase();
  if (!/^x-[a-z0-9-]+$/.test(header)) {
    throw new Error('Invalid ENTRA_ACCESS_TOKEN_HEADER');
  }
  if (!enabled) {
    return Object.freeze({ enabled, header });
  }
  for (const name of ['BEARER_TOKEN', 'N8N_WEBHOOK_BEARER_TOKEN']) {
    const value = env[name];
    if (
      !value ||
      !value.trim() ||
      value !== value.trim() ||
      /your|change.?me|replace|example|placeholder|dummy|[<>]/i.test(value) ||
      /^(secret|token|test|todo)$/i.test(value)
    ) {
      throw new Error(`Configure a non-placeholder ${name} for Entra verification`);
    }
  }
  for (const name of ['ENTRA_TENANT_ID', 'ENTRA_EXPECTED_AUDIENCE', 'ENTRA_ALLOWED_CLIENT_ID']) {
    if (!UUID.test(env[name] || '')) {
      throw new Error(`Invalid or missing ${name}`);
    }
  }
  const tenant = env.ENTRA_TENANT_ID.toLowerCase();
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  if (env.ENTRA_EXPECTED_ISSUER && env.ENTRA_EXPECTED_ISSUER !== issuer) {
    throw new Error('ENTRA_EXPECTED_ISSUER must be the exact tenant v2 issuer');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(env.ENTRA_REQUIRED_SCOPE || '')) {
    throw new Error('Configure ENTRA_REQUIRED_SCOPE as a bare delegated scope name');
  }
  return Object.freeze({
    enabled,
    header,
    tenant,
    issuer,
    audience: env.ENTRA_EXPECTED_AUDIENCE.toLowerCase(),
    client: env.ENTRA_ALLOWED_CLIENT_ID.toLowerCase(),
    scope: env.ENTRA_REQUIRED_SCOPE,
  });
}

/** Remove client authorization aliases/credentials, including nested metadata and messages. */
function sanitizeIdentity(value, header = 'x-entra-access-token') {
  const pending = [value];
  while (pending.length) {
    const object = pending.pop();
    if (!object || typeof object !== 'object') {
      continue;
    }
    for (const key of Object.keys(object)) {
      const alias = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (
        alias.startsWith('userauthorization') ||
        alias.startsWith('authorization') ||
        /^(user)?(authorizedgroups|groups|tid|oid|sub|exp|tokenexpiresat)$/.test(alias) ||
        /^(authorization|token|bearertoken|accesstoken|idtoken|entratoken|entraaccesstoken|jwt)$/.test(
          alias,
        ) ||
        alias === header.replace(/-/g, '') ||
        /^x(user)?(authorization.*|authorizedgroups|groups|tid|oid|sub|exp)$/.test(alias)
      ) {
        delete object[key];
      } else if (object[key] && typeof object[key] === 'object') {
        pending.push(object[key]);
      }
    }
  }
  return value;
}

function decodeSegment(segment) {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Invalid JWT');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) {
    throw new Error('Invalid JWT');
  }
  return bytes;
}

/** Create middleware; the trusted fetch dependency is injectable only by application/test code. */
function createEntraIdentity(settings, fetchKeys = globalThis.fetch) {
  let keys = [];
  let expiresAt = 0;
  let lastFetch = -Infinity;
  let pendingFetch;
  async function getKey(kid) {
    const now = Date.now();
    if (now >= expiresAt || !keys.some((key) => key.kid === kid)) {
      if (!pendingFetch) {
        if (now - lastFetch < 30000) {
          throw new Error('JWKS refresh cooldown');
        }
        lastFetch = now;
        pendingFetch = (async () => {
          const response = await fetchKeys(
            `https://login.microsoftonline.com/${settings.tenant}/discovery/v2.0/keys`,
            { signal: globalThis.AbortSignal.timeout(5000), redirect: 'error' },
          );
          if (!response.ok) {
            throw new Error('JWKS unavailable');
          }
          const text = await response.text();
          if (text.length > 131072) {
            throw new Error('JWKS too large');
          }
          const document = JSON.parse(text);
          if (!Array.isArray(document.keys) || document.keys.length > 100) {
            throw new Error('Invalid JWKS');
          }
          keys = document.keys;
          expiresAt = Date.now() + 3600000;
        })();
      }
      try {
        await pendingFetch;
      } finally {
        pendingFetch = null;
      }
    }
    const matches = keys.filter(
      (key) =>
        key.kid === kid &&
        key.kty === 'RSA' &&
        (!key.use || key.use === 'sig') &&
        (!key.alg || key.alg === 'RS256'),
    );
    if (matches.length !== 1) {
      throw new Error('Unknown signing key');
    }
    return createPublicKey({ key: matches[0], format: 'jwk' });
  }

  return async (req, res, next) => {
    const token = req.headers[settings.header];
    delete req.headers[settings.header];
    sanitizeIdentity(req.body, settings.header);
    let identity = deniedIdentity;
    if (settings.enabled && token !== undefined) {
      let rejection = 'token_format';
      try {
        if (typeof token !== 'string' || token.length > 32768) {
          throw new Error('Invalid JWT');
        }
        const parts = token.split('.');
        if (parts.length !== 3) {
          throw new Error('Invalid JWT');
        }
        const header = JSON.parse(decodeSegment(parts[0]).toString('utf8'));
        const claims = JSON.parse(decodeSegment(parts[1]).toString('utf8'));
        const signature = decodeSegment(parts[2]);
        rejection = 'token_header';
        if (
          !header ||
          header.alg !== 'RS256' ||
          typeof header.kid !== 'string' ||
          !header.kid ||
          header.kid.length > 256 ||
          header.crit !== undefined
        ) {
          throw new Error('Invalid JWT header');
        }
        const now = Math.floor(Date.now() / 1000);
        const expectedClaims = {
          token_version: claims?.ver === '2.0',
          tenant: claims?.tid === settings.tenant,
          issuer: claims?.iss === settings.issuer,
          audience: claims?.aud === settings.audience,
          caller: claims?.azp === settings.client,
          scope: typeof claims?.scp === 'string' && claims.scp.split(' ').includes(settings.scope),
        };
        rejection = Object.keys(expectedClaims).filter((name) => !expectedClaims[name]).join(',') || 'user_or_lifetime';
        if (
          !claims ||
          claims.ver !== '2.0' ||
          claims.tid !== settings.tenant ||
          claims.iss !== settings.issuer ||
          claims.aud !== settings.audience ||
          claims.azp !== settings.client ||
          claims.idtyp === 'app' ||
          typeof claims.scp !== 'string' ||
          !claims.scp.split(' ').includes(settings.scope) ||
          !UUID.test(claims.oid || '') ||
          typeof claims.sub !== 'string' ||
          !claims.sub.trim() ||
          !['exp', 'nbf', 'iat'].every(
            (name) => Number.isSafeInteger(claims[name]) && claims[name] >= 0,
          ) ||
          claims.exp <= now ||
          claims.nbf > now + 60 ||
          claims.iat > now + 60 ||
          claims.nbf >= claims.exp ||
          claims.iat >= claims.exp
        ) {
          throw new Error('Invalid delegated claims');
        }
        rejection = 'signing_key';
        const key = await getKey(header.kid);
        rejection = 'signature_or_expiry';
        if (
          !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, signature) ||
          claims.exp <= Math.floor(Date.now() / 1000)
        ) {
          throw new Error('Invalid signature');
        }
        const groups =
          !claims.hasgroups &&
          !claims._claim_names?.groups &&
          Array.isArray(claims.groups) &&
          claims.groups.length <= 200 &&
          claims.groups.every((group) => typeof group === 'string' && UUID.test(group))
            ? claims.groups
            : [];
        identity = Object.freeze({
          user_authorization_verified: true,
          user_authorization_mode: 'entra_delegated',
          user_authorized_groups: Object.freeze([...groups]),
          user_tid: claims.tid,
          user_oid: claims.oid,
          user_sub: claims.sub,
          user_token_expires_at: claims.exp,
        });
      } catch {
        // Fixed category names only: never log token bytes, claims, identities or groups.
        console.warn(`[entra] Access token rejected: ${rejection}`);
        return sendError(res, 401, 'Invalid Entra access token', 'authentication_error');
      }
    }
    Object.defineProperty(req, identityContext, { value: identity });
    return next();
  };
}

module.exports = {
  readEntraConfig,
  createEntraIdentity,
  sanitizeIdentity,
  identityContext,
  deniedIdentity,
};
