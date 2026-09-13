import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { certificate, idpMetadata } from '../../../../scripts/saml-contract-fixtures.mjs';
import { loadConfig, type AppConfig } from '../config.js';
import { loadSamlProtocolConfig, validateSamlSettings } from './saml-config.js';
import { MAX_XML_BYTES } from './saml-protocol.js';

describe('SAML trust configuration', () => {
  let directory: string, config: AppConfig, xml: string;
  let sp: Awaited<ReturnType<typeof certificate>>, idp: Awaited<ReturnType<typeof certificate>>;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-saml-config-'));
    sp = await certificate(directory, 'sp');
    idp = await certificate(directory, 'idp');
    config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/unused',
      AUTH_MODE: 'saml',
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://gcr.test',
      SAML_IDP_ISSUER: 'https://idp.test/realms/gcr',
      SAML_IDP_ENTRY_POINT: 'https://idp.test/realms/gcr/protocol/saml',
      SAML_IDP_METADATA_URL: 'https://idp.test/realms/gcr/descriptor',
      SAML_PRIVATE_KEY_FILE: sp.keyPath,
      SAML_PUBLIC_CERT_FILE: sp.certPath,
    });
    xml = idpMetadata(
      { idpIssuer: config.SAML_IDP_ISSUER, entryPoint: config.SAML_IDP_ENTRY_POINT },
      [idp.cert],
    );
    await writeFile(path.join(directory, 'metadata.xml'), xml, { mode: 0o600 });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('derives exact SP endpoints and allows an explicit entity ID', () => {
    expect(validateSamlSettings(config)).toEqual({
      issuer: 'https://idp.test/realms/gcr',
      entityId: 'https://gcr.test/auth/saml/metadata',
      acsUrl: 'https://gcr.test/auth/saml/acs',
      sloUrl: 'https://gcr.test/auth/saml/slo',
    });
    expect(
      validateSamlSettings({ ...config, SAML_ENTITY_ID: 'https://gcr.test/entity' }).entityId,
    ).toBe('https://gcr.test/entity');
  });
  it.each([
    ['PUBLIC_BASE_URL', 'http://gcr.test'],
    ['PUBLIC_BASE_URL', 'https://gcr.test/prefix'],
    ['PUBLIC_BASE_URL', 'https://secret:password@gcr.test'],
    ['PUBLIC_BASE_URL', 'https://gcr.test?query=secret'],
    ['SAML_IDP_ISSUER', undefined],
    ['SAML_IDP_ISSUER', 'http://idp.test/realms/gcr'],
    ['SAML_IDP_ENTRY_POINT', 'https://other.test/saml'],
    ['SAML_IDP_ENTRY_POINT', 'https://idp.test/saml?query=secret'],
    ['SAML_IDP_METADATA_URL', 'http://idp.test/descriptor'],
    ['SAML_IDP_METADATA_URL', 'https://other.test/descriptor'],
    ['SAML_PRIVATE_KEY_FILE', 'relative.key'],
    ['SAML_PUBLIC_CERT_FILE', undefined],
    ['SAML_IDP_METADATA_FILE', 'relative.xml'],
  ])('rejects invalid %s without echoing its value', (field, value) => {
    expect(() => validateSamlSettings({ ...config, [field]: value })).toThrow(
      'Invalid configuration: complete HTTPS SAML settings and mounted signing key/certificate are required',
    );
  });
  it('requires SAML trust only for serve, with no fallback to another auth mode', () => {
    const environment = { DATABASE_URL: 'postgresql://localhost/unused', AUTH_MODE: 'saml' };
    expect(() => loadConfig(environment)).toThrow('complete HTTPS SAML settings');
    for (const command of ['worker', 'migrate', 'retention'] as const)
      expect(loadConfig(environment, command).AUTH_MODE).toBe('saml');
  });
  it('loads an explicit approved metadata file without attempting network access', async () => {
    const request = vi.fn<typeof fetch>();
    const protocol = await loadSamlProtocolConfig(
      { ...config, SAML_IDP_METADATA_FILE: path.join(directory, 'metadata.xml') },
      request,
    );
    expect(request).not.toHaveBeenCalled();
    expect(protocol.idpCerts).toHaveLength(1);
    expect(Object.isFrozen(protocol)).toBe(true);
    expect(Object.isFrozen(protocol.idpCerts)).toBe(true);
  });
  it('fetches only the approved URL with redirects forbidden and a bounded timeout', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(xml, {
        headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8' },
      }),
    );
    const protocol = await loadSamlProtocolConfig(config, request);
    expect(protocol.idpIssuer).toBe(config.SAML_IDP_ISSUER);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(config.SAML_IDP_METADATA_URL);
    expect(request.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    ['non-XML content', () => new Response(xml, { headers: { 'content-type': 'text/html' } })],
    ['failed response', () => new Response('untrusted upstream message', { status: 503 })],
    [
      'too much XML',
      () =>
        new Response(' '.repeat(MAX_XML_BYTES + 1), {
          headers: { 'content-type': 'application/xml' },
        }),
    ],
    [
      'wrong issuer',
      () =>
        new Response(
          xml.replace('entityID="https://idp.test/realms/gcr"', 'entityID="https://wrong.test"'),
          { headers: { 'content-type': 'application/xml' } },
        ),
    ],
    [
      'invalid UTF-8',
      () =>
        new Response(new Uint8Array([0xff, 0xfe]), {
          headers: { 'content-type': 'application/xml' },
        }),
    ],
  ])('rejects %s without using cached or message-provided trust', async (_name, response) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await expect(loadSamlProtocolConfig(config, request)).rejects.toThrow(
      'SAML signing key or approved IdP metadata could not be verified',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('sanitizes a network failure and does not try a fallback URL', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Error('private transport detail with credentials'));
    await expect(loadSamlProtocolConfig(config, request)).rejects.toThrow(
      'Invalid configuration: SAML signing key or approved IdP metadata could not be verified',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched SP key/certificate before fetching metadata', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      loadSamlProtocolConfig({ ...config, SAML_PUBLIC_CERT_FILE: idp.certPath }, request),
    ).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds files and refuses a directory or malformed UTF-8 as trust material', async () => {
    const file = path.join(directory, 'invalid-material');
    for (const bytes of [Buffer.alloc(16 * 1024 + 1), Buffer.from([0xff])]) {
      await writeFile(file, bytes, { mode: 0o600 });
      await expect(
        loadSamlProtocolConfig({ ...config, SAML_PRIVATE_KEY_FILE: file }),
      ).rejects.toThrow('could not be verified');
    }
    await expect(
      loadSamlProtocolConfig({ ...config, SAML_PRIVATE_KEY_FILE: directory }),
    ).rejects.toThrow('could not be verified');
    await writeFile(file, ' '.repeat(MAX_XML_BYTES + 1));
    await expect(
      loadSamlProtocolConfig({ ...config, SAML_IDP_METADATA_FILE: file }),
    ).rejects.toThrow('could not be verified');
    expect(await readFile(sp.keyPath, 'utf8')).toBe(sp.key);
  });
});
