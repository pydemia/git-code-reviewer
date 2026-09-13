import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { MAX_XML_BYTES, parseIdpMetadata, type SamlProtocolConfig } from './saml-protocol.js';
import { samlConfigurationKey, type SamlProviderBinding } from './saml-state.js';

export const samlRoutes = Object.freeze({
  login: '/auth/saml/login',
  acs: '/auth/saml/acs',
  slo: '/auth/saml/slo',
  metadata: '/auth/saml/metadata',
});

type Settings = Pick<
  AppConfig,
  | 'PUBLIC_BASE_URL'
  | 'SAML_ENTITY_ID'
  | 'SAML_IDP_ISSUER'
  | 'SAML_IDP_ENTRY_POINT'
  | 'SAML_IDP_METADATA_URL'
  | 'SAML_IDP_METADATA_FILE'
  | 'SAML_PRIVATE_KEY_FILE'
  | 'SAML_PUBLIC_CERT_FILE'
>;

export function validateSamlSettings(config: Settings): SamlProviderBinding {
  try {
    const publicUrl = new URL(config.PUBLIC_BASE_URL!);
    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash
    )
      throw Error();
    const binding = {
      issuer: config.SAML_IDP_ISSUER!,
      entityId: config.SAML_ENTITY_ID ?? publicUrl.origin + samlRoutes.metadata,
      acsUrl: publicUrl.origin + samlRoutes.acs,
      sloUrl: publicUrl.origin + samlRoutes.slo,
    };
    samlConfigurationKey(binding);
    for (const field of [config.SAML_IDP_ENTRY_POINT, config.SAML_IDP_METADATA_URL]) {
      const url = new URL(field!);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.href !== field ||
        url.origin !== new URL(binding.issuer).origin
      )
        throw Error();
    }
    for (const file of [config.SAML_PRIVATE_KEY_FILE, config.SAML_PUBLIC_CERT_FILE])
      if (!file || !path.isAbsolute(file) || file.includes('\0')) throw Error();
    if (
      config.SAML_IDP_METADATA_FILE &&
      (!path.isAbsolute(config.SAML_IDP_METADATA_FILE) ||
        config.SAML_IDP_METADATA_FILE.includes('\0'))
    )
      throw Error();
    return Object.freeze(binding);
  } catch {
    throw new Error(
      'Invalid configuration: complete HTTPS SAML settings and mounted signing key/certificate are required',
    );
  }
}

async function boundedFile(file: string, maximum = 16 * 1024): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Error();
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

export async function loadSamlProtocolConfig(
  config: Settings,
  request: typeof fetch = fetch,
): Promise<SamlProtocolConfig> {
  const binding = validateSamlSettings(config);
  try {
    const [privateKey, publicCert] = await Promise.all([
      boundedFile(config.SAML_PRIVATE_KEY_FILE!),
      boundedFile(config.SAML_PUBLIC_CERT_FILE!),
    ]);
    const key = createPrivateKey(privateKey),
      cert = new X509Certificate(publicCert);
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) <= Date.now() ||
      !createPublicKey(key)
        .export({ type: 'spki', format: 'der' })
        .equals(cert.publicKey.export({ type: 'spki', format: 'der' }))
    )
      throw Error();
    let xml: string;
    // A configured metadata file is an explicit trust pin installed from the
    // approved URL, not a fallback after network/verification failure.
    if (config.SAML_IDP_METADATA_FILE)
      xml = await boundedFile(config.SAML_IDP_METADATA_FILE, MAX_XML_BYTES);
    else {
      const response = await request(config.SAML_IDP_METADATA_URL!, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
      });
      if (
        !response.ok ||
        !response.body ||
        !/^(application\/(samlmetadata\+xml|xml)|text\/xml)(;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        await response.body?.cancel();
        throw Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_XML_BYTES) throw Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    }
    const idpCerts = parseIdpMetadata(xml, {
      issuer: binding.issuer,
      entryPoint: config.SAML_IDP_ENTRY_POINT!,
    });
    return Object.freeze({
      acs: binding.acsUrl,
      slo: binding.sloUrl,
      entityId: binding.entityId,
      idpIssuer: binding.issuer,
      entryPoint: config.SAML_IDP_ENTRY_POINT!,
      privateKey,
      publicCert,
      idpCerts: Object.freeze(idpCerts),
    });
  } catch {
    throw new Error(
      'Invalid configuration: SAML signing key or approved IdP metadata could not be verified',
    );
  }
}
