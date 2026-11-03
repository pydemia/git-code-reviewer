import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certificate, signedLogoutRequest } from '../../../../scripts/saml-contract-fixtures.mjs';
import {
  SamlContractError,
  verifyLogoutRequest,
  type SamlProtocolConfig,
} from './saml-protocol.js';

describe('IdP initiated SAML logout signature and protocol', () => {
  let directory: string, config: SamlProtocolConfig, key: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-saml-logout-protocol-'));
    const sp = await certificate(directory, 'sp'),
      idp = await certificate(directory, 'idp');
    key = idp.key;
    config = {
      acs: 'https://gcr.test/auth/saml/acs',
      slo: 'https://gcr.test/auth/saml/slo',
      entityId: 'https://gcr.test/auth/saml/metadata',
      idpIssuer: 'https://idp.test/realms/gcr',
      entryPoint: 'https://idp.test/realms/gcr/protocol/saml',
      privateKey: sp.key,
      publicCert: sp.cert,
      idpCerts: [idp.cert],
    };
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it.each([null, 'relay state +/=한글', 'SigAlg=RelayState&Signature=opaque'])(
    'accepts an optional opaque RelayState %s and exact multiple SessionIndexes',
    async (relayState) => {
      const query = signedLogoutRequest(config, key, { relayState, sessionIndexes: ['a', 'b'] });
      const result = await verifyLogoutRequest(config, query);
      expect(result).toMatchObject({
        nameID: 'synthetic-persistent-id',
        sessionIndexes: ['a', 'b'],
        relayState: relayState ?? '',
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.sessionIndexes)).toBe(true);
      // HTTP parameter ordering is independent of the SAML signature input order.
      expect(await verifyLogoutRequest(config, query.split('&').reverse().join('&'))).toEqual(
        result,
      );
    },
  );
  it.each([
    ['wrong issuer', { issuer: 'https://wrong.test' }],
    ['wrong destination', { destination: 'https://wrong.test/slo' }],
    ['email NameID', { nameFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' }],
    ['wrong NameQualifier', { nameQualifier: 'https://wrong.test' }],
    ['wrong SPNameQualifier', { spNameQualifier: 'https://wrong.test' }],
    ['no SessionIndex', { sessionIndexes: [] }],
    ['empty SessionIndex', { sessionIndexes: [''] }],
    ['duplicate SessionIndex', { sessionIndexes: ['a', 'a'] }],
    [
      'too many SessionIndexes',
      { sessionIndexes: Array.from({ length: 33 }, (_, i) => String(i)) },
    ],
    ['long SessionIndex', { sessionIndexes: ['x'.repeat(1025)] }],
    ['expired request', { expires: new Date(Date.now() - 120_000).toISOString() }],
    ['old IssueInstant', { issued: new Date(Date.now() - 600_000).toISOString() }],
    ['future IssueInstant', { issued: new Date(Date.now() + 120_000).toISOString() }],
    ['oversized RelayState', { relayState: '한'.repeat(27) }],
    ['control in RelayState', { relayState: 'line\nend' }],
  ])('rejects %s even with a valid IdP signature', async (_name, changes) => {
    await expect(
      verifyLogoutRequest(config, signedLogoutRequest(config, key, changes)),
    ).rejects.toBeInstanceOf(SamlContractError);
  });
  it.each([
    ['missing signature', (query: string) => query.replace(/&Signature=[^&]+/, '')],
    ['duplicate signature', (query: string) => query + '&Signature=synthetic'],
    ['duplicate message', (query: string) => query + '&SAMLRequest=synthetic'],
    ['extra field', (query: string) => query + '&untrusted=value'],
    ['encoded key', (query: string) => query.replace('SAMLRequest=', '%53AMLRequest=')],
    ['weak algorithm', (query: string) => query.replace('rsa-sha256', 'rsa-sha1')],
    ['modified relay', (query: string) => query.replace('synthetic-idp-relay', 'attacker-relay')],
    [
      'invalid signature',
      (query: string) => query.replace(/Signature=[^&]+/, 'Signature=c3ludGhldGlj'),
    ],
  ])('rejects %s without exposing library errors', async (_name, mutate) => {
    await expect(
      verifyLogoutRequest(config, mutate(signedLogoutRequest(config, key))),
    ).rejects.toThrow('SAML message rejected');
  });
});
