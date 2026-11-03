// Shared SAML protocol verifier. Cryptographic verification stays in Node-SAML / xml-crypto.
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import {
  DOMParser,
  type Node as XmlNode,
  type Element as XmlElement,
  type Document as XmlDocument,
} from '@xmldom/xmldom';
import type { VerifiedSamlLogin, VerifiedSamlLogoutRequest, SamlIdentity } from './saml-state.js';
import { SignedXml } from 'xml-crypto';
import { randomBytes, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export interface SamlProtocolConfig {
  readonly acs: string;
  readonly slo: string;
  readonly entityId: string;
  readonly idpIssuer: string;
  readonly entryPoint: string;
  readonly privateKey: string;
  readonly publicCert: string;
  readonly idpCerts: readonly string[];
}
export interface SamlProtocolTransaction {
  readonly kind: 'login' | 'logout';
  readonly requestId: string;
  readonly relayState: string;
  readonly createdAt: number;
  readonly consumed: boolean;
}
export type SamlLogoutIdentity = SamlIdentity & { readonly sessionIndex: string };

export const NS = Object.freeze({
  protocol: 'urn:oasis:names:tc:SAML:2.0:protocol',
  assertion: 'urn:oasis:names:tc:SAML:2.0:assertion',
  metadata: 'urn:oasis:names:tc:SAML:2.0:metadata',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
});
export const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const DIGEST256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
export const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
export const MAX_XML_BYTES = 128 * 1024;
export const TRANSACTION_MS = 5 * 60 * 1000;
export const CLOCK_SKEW_MS = 60 * 1000;
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

export class SamlContractError extends Error {
  constructor() {
    super('SAML message rejected');
    this.name = 'SamlContractError';
  }
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new SamlContractError();
}
export function elements(node: XmlNode, namespace: string, name: string): XmlElement[] {
  return Array.from(node.childNodes ?? []).filter(
    (child): child is XmlElement =>
      child.nodeType === 1 && child.namespaceURI === namespace && child.localName === name,
  );
}
export function one(node: XmlNode, namespace: string, name: string): XmlElement {
  const found = elements(node, namespace, name);
  requireValue(found.length === 1);
  return found[0]!;
}
function text(node: XmlElement): string {
  requireValue(Array.from(node.childNodes).every((child) => child.nodeType === 3));
  const value = node.textContent;
  requireValue(
    value &&
      value.length <= 4096 &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
  return value;
}
function attr(node: XmlElement, name: string): string {
  const value = node.getAttribute(name);
  requireValue(value && value.length <= 4096);
  return value;
}
export function parseXml(xml: string): XmlDocument {
  requireValue(typeof xml === 'string' && Buffer.byteLength(xml) <= MAX_XML_BYTES);
  // This profile needs neither DTD/entity declarations nor comments/CDATA. Reject
  // them before either XML parser is called; no schema or external URL is fetched.
  requireValue(!/<!|<\?(?!xml(?:\s|\?>))/i.test(xml));
  const doc = new DOMParser({
    onError: () => {
      throw new SamlContractError();
    },
  }).parseFromString(xml, 'application/xml');
  requireValue(doc.documentElement);
  const all = Array.from(doc.getElementsByTagName('*'));
  requireValue(all.length <= 512);
  const ids = new Set();
  for (const node of all) {
    for (const attribute of Array.from(node.attributes)) {
      requireValue(attribute.localName);
      if (attribute.localName.toLowerCase() !== 'id') continue;
      requireValue(
        attribute.name === 'ID' &&
          !attribute.namespaceURI &&
          /^[_A-Za-z][_A-Za-z0-9.-]{0,255}$/.test(attribute.value) &&
          !ids.has(attribute.value),
      );
      ids.add(attribute.value);
    }
  }
  return doc;
}
function decodeBase64(encoded: unknown): Buffer {
  requireValue(
    typeof encoded === 'string' &&
      encoded.length > 0 &&
      encoded.length <= Math.ceil(MAX_XML_BYTES / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
  );
  const bytes = Buffer.from(encoded, 'base64');
  requireValue(bytes.length <= MAX_XML_BYTES && bytes.toString('base64') === encoded);
  return bytes;
}
function rootElement(doc: XmlDocument, namespace: string, name: string): XmlElement {
  const root = doc.documentElement;
  requireValue(root);
  requireValue(root.namespaceURI === namespace && root.localName === name);
  return root;
}
function timestamp(node: XmlElement, name: string): number {
  const raw = attr(node, name);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw));
  const value = Date.parse(raw);
  requireValue(Number.isFinite(value));
  return value;
}
function recent(node: XmlElement, now: number): void {
  requireValue(attr(node, 'Version') === '2.0');
  attr(node, 'ID');
  const issued = timestamp(node, 'IssueInstant');
  requireValue(issued <= now + CLOCK_SKEW_MS && now - issued < TRANSACTION_MS + CLOCK_SKEW_MS);
}
function signatureProfile(node: XmlElement): void {
  const signature = one(node, NS.ds, 'Signature');
  const info = one(signature, NS.ds, 'SignedInfo');
  requireValue(attr(one(info, NS.ds, 'SignatureMethod'), 'Algorithm') === SHA256);
  requireValue(attr(one(info, NS.ds, 'CanonicalizationMethod'), 'Algorithm') === C14N);
  const ref = one(info, NS.ds, 'Reference');
  requireValue(attr(ref, 'URI') === `#${attr(node, 'ID')}`);
  requireValue(attr(one(ref, NS.ds, 'DigestMethod'), 'Algorithm') === DIGEST256);
  const transforms = elements(one(ref, NS.ds, 'Transforms'), NS.ds, 'Transform');
  requireValue(
    transforms.length === 2 &&
      attr(transforms[0]!, 'Algorithm') === `${NS.ds}enveloped-signature` &&
      attr(transforms[1]!, 'Algorithm') === C14N,
  );
  requireValue(
    signature.getElementsByTagNameNS(NS.ds, 'Object').length === 0 &&
      signature.getElementsByTagNameNS(NS.ds, 'RetrievalMethod').length === 0,
  );
}
function assertTransaction(
  tx: SamlProtocolTransaction,
  now: number,
  kind: 'login' | 'logout',
): void {
  requireValue(
    tx &&
      tx.kind === kind &&
      !tx.consumed &&
      typeof tx.requestId === 'string' &&
      Number.isFinite(tx.createdAt) &&
      tx.createdAt <= now &&
      now < tx.createdAt + TRANSACTION_MS,
  );
}
// Node-SAML 5.1.0 searches the whole query field for parameter names. An opaque
// RelayState (or even a base64 message) containing "SigAlg" can select the wrong
// field. Override that protected extraction hook; keep the library's certificate
// resolution and cryptographic verifier, with exact names and RSA-SHA256 required.
class StrictRedirectSaml extends SAML {
  protected override async hasValidSignatureForRedirect(
    container: Parameters<SAML['validateRedirectAsync']>[0],
    originalQuery: string,
  ): Promise<void> {
    const messageKey = container.SAMLRequest ? 'SAMLRequest' : 'SAMLResponse';
    const { params, signedQuery } = redirectParameters(
      originalQuery,
      messageKey,
      messageKey === 'SAMLResponse',
    );
    requireValue(Object.keys(container).length === params.size);
    for (const [name, value] of params) requireValue(container[name] === value);
    const certs = await this.getKeyInfosAsPem();
    requireValue(
      certs.some((cert) =>
        this.validateSignatureForRedirect(signedQuery, params.get('Signature')!, SHA256, cert),
      ),
    );
  }
}

function makeSaml(config: SamlProtocolConfig, tx: SamlProtocolTransaction): SAML {
  return new StrictRedirectSaml({
    callbackUrl: config.acs,
    issuer: config.entityId,
    audience: config.entityId,
    idpIssuer: config.idpIssuer,
    entryPoint: config.entryPoint,
    logoutUrl: config.entryPoint,
    logoutCallbackUrl: config.slo,
    idpCert: [...config.idpCerts],
    privateKey: config.privateKey,
    publicCert: config.publicCert,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    xmlSignatureTransforms: [`${NS.ds}enveloped-signature`, C14N],
    identifierFormat: PERSISTENT,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: TRANSACTION_MS,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    maxAssertionAgeMs: TRANSACTION_MS,
    disableRequestedAuthnContext: true,
    authnRequestBinding: 'HTTP-Redirect',
    generateUniqueId: () => tx.requestId,
    signMetadata: true,
    // Library cache deletion is not atomic acceptance and happens on errors too.
    // Scope this read-only validation view to the already browser-bound request.
    // The caller must atomically consume transaction + both IDs after validation.
    cacheProvider: {
      async saveAsync(key, value) {
        requireValue(key === tx.requestId);
        return { value, createdAt: tx.createdAt };
      },
      async getAsync(key) {
        return key === tx.requestId && !tx.consumed && Date.now() < tx.createdAt + TRANSACTION_MS
          ? new Date(tx.createdAt).toISOString()
          : null;
      },
      async removeAsync() {
        return null;
      },
    },
  });
}
export function transaction(kind: 'login' | 'logout' = 'login') {
  return {
    kind,
    requestId: `_${randomBytes(24).toString('hex')}`,
    nonce: randomBytes(32).toString('base64url'),
    relayState: randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    consumed: false,
  };
}
export async function loginUrl(
  config: SamlProtocolConfig,
  tx: SamlProtocolTransaction,
): Promise<string> {
  assertTransaction(tx, Date.now(), 'login');
  return makeSaml(config, tx).getAuthorizeUrlAsync(tx.relayState, undefined, {});
}
export function metadata(config: SamlProtocolConfig): string {
  const tx = transaction();
  const saml = makeSaml(config, tx);
  // Node-SAML 5.1.0's metadata generator hardcodes POST for SLO. Publish only
  // the binding implemented here, then sign the resulting metadata with the
  // maintained XML-signature library (never edit already-signed metadata).
  saml.options.signMetadata = false;
  const doc = parseXml(saml.generateServiceProviderMetadata(null, config.publicCert));
  const root = rootElement(doc, NS.metadata, 'EntityDescriptor');
  const descriptor = one(root, NS.metadata, 'SPSSODescriptor');
  one(descriptor, NS.metadata, 'SingleLogoutService').setAttribute('Binding', REDIRECT);
  root.setAttribute('ID', tx.requestId);
  const signer = new SignedXml({
    privateKey: config.privateKey,
    publicCert: config.publicCert,
    signatureAlgorithm: SHA256,
    canonicalizationAlgorithm: C14N,
  });
  signer.addReference({
    xpath: "/*[local-name()='EntityDescriptor']",
    transforms: [`${NS.ds}enveloped-signature`, C14N],
    digestAlgorithm: DIGEST256,
  });
  signer.computeSignature(doc.toString(), {
    prefix: 'ds',
    location: {
      reference: "/*[local-name()='EntityDescriptor']/*[local-name()='SPSSODescriptor']",
      action: 'before',
    },
  });
  return signer.getSignedXml();
}
export async function verifyLogin(
  config: SamlProtocolConfig,
  encoded: string,
  tx: SamlProtocolTransaction,
): Promise<Readonly<VerifiedSamlLogin & { replayUntil: number }>> {
  try {
    const now = Date.now();
    assertTransaction(tx, now, 'login');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(encoded));
    const doc = parseXml(xml);
    const response = rootElement(doc, NS.protocol, 'Response');
    recent(response, now);
    requireValue(
      attr(response, 'Destination') === config.acs &&
        attr(response, 'InResponseTo') === tx.requestId &&
        text(one(response, NS.assertion, 'Issuer')) === config.idpIssuer,
    );
    requireValue(
      doc.getElementsByTagNameNS(NS.assertion, 'Assertion').length === 1 &&
        doc.getElementsByTagNameNS(NS.assertion, 'EncryptedAssertion').length === 0 &&
        doc.getElementsByTagNameNS(NS.ds, 'Signature').length === 2,
    );
    requireValue(
      attr(one(one(response, NS.protocol, 'Status'), NS.protocol, 'StatusCode'), 'Value') ===
        SUCCESS,
    );
    const originalAssertion = one(response, NS.assertion, 'Assertion');
    signatureProfile(response);
    signatureProfile(originalAssertion);
    const { profile, loggedOut } = await makeSaml(config, tx).validatePostResponseAsync({
      SAMLResponse: encoded,
    });
    requireValue(profile && !loggedOut && typeof profile.getAssertionXml === 'function');
    // Read the assertion returned from verified content, never getSamlResponseXml.
    const assertion = rootElement(parseXml(profile.getAssertionXml()), NS.assertion, 'Assertion');
    recent(assertion, now);
    requireValue(text(one(assertion, NS.assertion, 'Issuer')) === config.idpIssuer);
    const subject = one(assertion, NS.assertion, 'Subject');
    const name = one(subject, NS.assertion, 'NameID');
    requireValue(attr(name, 'Format') === PERSISTENT);
    for (const [key, expected] of [
      ['NameQualifier', config.idpIssuer],
      ['SPNameQualifier', config.entityId],
    ] as const) {
      requireValue(!name.hasAttribute(key) || name.getAttribute(key) === expected);
    }
    const confirmation = one(subject, NS.assertion, 'SubjectConfirmation');
    requireValue(attr(confirmation, 'Method') === BEARER);
    const data = one(confirmation, NS.assertion, 'SubjectConfirmationData');
    requireValue(
      attr(data, 'Recipient') === config.acs && attr(data, 'InResponseTo') === tx.requestId,
    );
    const conditions = one(assertion, NS.assertion, 'Conditions');
    const notBefore = timestamp(conditions, 'NotBefore');
    const expires = timestamp(conditions, 'NotOnOrAfter');
    const subjectExpires = timestamp(data, 'NotOnOrAfter');
    requireValue(
      notBefore <= now + CLOCK_SKEW_MS &&
        expires > now - CLOCK_SKEW_MS &&
        subjectExpires > now - CLOCK_SKEW_MS &&
        expires > notBefore,
    );
    const restrictions = elements(conditions, NS.assertion, 'AudienceRestriction');
    requireValue(
      restrictions.length > 0 &&
        restrictions.every((restriction) =>
          elements(restriction, NS.assertion, 'Audience').some(
            (node) => text(node) === config.entityId,
          ),
        ),
    );
    const authn = one(assertion, NS.assertion, 'AuthnStatement');
    const sessionExpires = timestamp(authn, 'SessionNotOnOrAfter');
    requireValue(sessionExpires > now && timestamp(authn, 'AuthnInstant') <= now + CLOCK_SKEW_MS);
    return Object.freeze({
      responseId: attr(response, 'ID'),
      assertionId: attr(assertion, 'ID'),
      requestId: tx.requestId,
      issuer: config.idpIssuer,
      entityId: config.entityId,
      nameID: text(name),
      nameIDFormat: PERSISTENT,
      nameQualifier: name.getAttribute('NameQualifier') || null,
      spNameQualifier: name.getAttribute('SPNameQualifier') || null,
      sessionIndex: attr(authn, 'SessionIndex'),
      sessionExpiresAt: Math.min(sessionExpires, now + 8 * 60 * 60 * 1000),
      replayUntil: Math.max(expires, subjectExpires, now + TRANSACTION_MS) + CLOCK_SKEW_MS,
    });
  } catch {
    throw new SamlContractError();
  }
}
export async function logoutUrl(
  config: SamlProtocolConfig,
  tx: SamlProtocolTransaction,
  identity: SamlLogoutIdentity,
): Promise<string> {
  assertTransaction(tx, Date.now(), 'logout');
  return makeSaml(config, tx).getLogoutUrlAsync(
    {
      issuer: config.entityId,
      nameID: identity.nameID,
      nameIDFormat: identity.nameIDFormat,
      ...(identity.nameQualifier ? { nameQualifier: identity.nameQualifier } : {}),
      ...(identity.spNameQualifier ? { spNameQualifier: identity.spNameQualifier } : {}),
      sessionIndex: identity.sessionIndex,
    },
    tx.relayState,
    {},
  );
}
export async function verifyLogoutResponse(
  config: SamlProtocolConfig,
  rawQuery: string,
  tx: SamlProtocolTransaction,
) {
  try {
    assertTransaction(tx, Date.now(), 'logout');
    const { params, canonicalQuery } = redirectParameters(rawQuery, 'SAMLResponse', true);
    requireValue(params.get('RelayState') === tx.relayState);
    // Check bounded decompression before the library's unbounded inflate path.
    const inflated = inflateRawSync(decodeBase64(params.get('SAMLResponse')), {
      maxOutputLength: MAX_XML_BYTES,
    });
    const root = rootElement(
      parseXml(new TextDecoder('utf-8', { fatal: true }).decode(inflated)),
      NS.protocol,
      'LogoutResponse',
    );
    recent(root, Date.now());
    requireValue(
      attr(root, 'Destination') === config.slo &&
        attr(root, 'InResponseTo') === tx.requestId &&
        text(one(root, NS.assertion, 'Issuer')) === config.idpIssuer &&
        attr(one(one(root, NS.protocol, 'Status'), NS.protocol, 'StatusCode'), 'Value') === SUCCESS,
    );
    requireValue((params.get('Signature')?.length ?? 0) > 0);
    const result = await makeSaml(config, tx).validateRedirectAsync(
      Object.fromEntries(params),
      canonicalQuery,
    );
    requireValue(result.loggedOut && result.profile === null);
    return { responseId: attr(root, 'ID'), requestId: tx.requestId };
  } catch {
    throw new SamlContractError();
  }
}

function redirectParameters(
  rawQuery: string,
  messageKey: 'SAMLResponse' | 'SAMLRequest',
  requireRelayState: boolean,
) {
  requireValue(typeof rawQuery === 'string' && rawQuery.length < MAX_XML_BYTES);
  const params = new URLSearchParams(rawQuery);
  const keys = [messageKey, 'SigAlg', 'Signature'];
  if (requireRelayState || params.has('RelayState')) keys.push('RelayState');
  requireValue(
    Array.from(params.keys()).length === keys.length &&
      keys.every((key) => params.getAll(key).length === 1),
  );
  requireValue(params.get('SigAlg') === SHA256 && (params.get('Signature')?.length ?? 0) > 0);
  const relay = params.get('RelayState');
  requireValue(
    relay === null ||
      (Buffer.byteLength(relay) <= 80 &&
        [...relay].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  );
  // Preserve each parameter's original encoding when constructing the signature
  // input. Require literal keys to avoid disagreement with the library's parser.
  const raw = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const name = field.slice(0, field.indexOf('='));
    requireValue(keys.includes(name) && !raw.has(name));
    raw.set(name, field);
  }
  const signedQuery = [
    raw.get(messageKey),
    ...(relay !== null ? [raw.get('RelayState')] : []),
    raw.get('SigAlg'),
  ].join('&');
  const canonicalQuery = `${signedQuery}&${raw.get('Signature')}`;
  return { params, canonicalQuery, signedQuery };
}

export async function verifyLogoutRequest(
  config: SamlProtocolConfig,
  rawQuery: string,
): Promise<Readonly<VerifiedSamlLogoutRequest & { relayState: string }>> {
  try {
    const { params, canonicalQuery } = redirectParameters(rawQuery, 'SAMLRequest', false);
    const inflated = inflateRawSync(decodeBase64(params.get('SAMLRequest')), {
      maxOutputLength: MAX_XML_BYTES,
    });
    const doc = parseXml(new TextDecoder('utf-8', { fatal: true }).decode(inflated));
    const root = rootElement(doc, NS.protocol, 'LogoutRequest');
    const now = Date.now();
    recent(root, now);
    requireValue(
      attr(root, 'Destination') === config.slo &&
        text(one(root, NS.assertion, 'Issuer')) === config.idpIssuer,
    );
    if (root.hasAttribute('NotOnOrAfter'))
      requireValue(timestamp(root, 'NotOnOrAfter') > now - CLOCK_SKEW_MS);
    requireValue(doc.getElementsByTagNameNS(NS.assertion, 'NameID').length === 1);
    const name = one(root, NS.assertion, 'NameID');
    requireValue(attr(name, 'Format') === PERSISTENT);
    for (const [key, expected] of [
      ['NameQualifier', config.idpIssuer],
      ['SPNameQualifier', config.entityId],
    ] as const)
      requireValue(!name.hasAttribute(key) || name.getAttribute(key) === expected);
    const sessionIndexes = elements(root, NS.protocol, 'SessionIndex').map(text);
    requireValue(
      sessionIndexes.length >= 1 &&
        sessionIndexes.length <= 32 &&
        new Set(sessionIndexes).size === sessionIndexes.length &&
        sessionIndexes.every((index) => index.length <= 1024),
    );
    const result = await makeSaml(config, transaction('logout')).validateRedirectAsync(
      Object.fromEntries(params),
      canonicalQuery,
    );
    requireValue(
      result.loggedOut &&
        result.profile &&
        result.profile.ID === attr(root, 'ID') &&
        result.profile.nameID === text(name),
    );
    return Object.freeze({
      issuer: config.idpIssuer,
      entityId: config.entityId,
      nameID: text(name),
      nameIDFormat: PERSISTENT,
      nameQualifier: name.getAttribute('NameQualifier') || null,
      spNameQualifier: name.getAttribute('SPNameQualifier') || null,
      requestId: attr(root, 'ID'),
      sessionIndexes: Object.freeze(sessionIndexes),
      relayState: params.get('RelayState') ?? '',
    });
  } catch {
    throw new SamlContractError();
  }
}

export async function logoutResponseUrl(
  config: SamlProtocolConfig,
  request: VerifiedSamlLogoutRequest & { relayState: string },
): Promise<string> {
  return makeSaml(config, transaction('logout')).getLogoutResponseUrlAsync(
    {
      issuer: request.issuer,
      ID: request.requestId,
      nameID: request.nameID,
      nameIDFormat: request.nameIDFormat,
    },
    request.relayState,
    {},
    true,
  );
}

// The caller obtains this document from an explicitly approved HTTPS URL
// outside the response handler. These certificates are never sourced from SAML.
export function parseIdpMetadata(
  xml: string,
  { issuer, entryPoint }: { issuer: string; entryPoint: string },
): string[] {
  const root = rootElement(parseXml(xml), NS.metadata, 'EntityDescriptor');
  requireValue(attr(root, 'entityID') === issuer);
  const descriptor = one(root, NS.metadata, 'IDPSSODescriptor');
  for (const name of ['SingleSignOnService', 'SingleLogoutService']) {
    const endpoint = elements(descriptor, NS.metadata, name).filter(
      (node) => node.getAttribute('Binding') === REDIRECT,
    );
    requireValue(endpoint.length === 1 && attr(endpoint[0]!, 'Location') === entryPoint);
  }
  const certs = elements(descriptor, NS.metadata, 'KeyDescriptor')
    .filter((node) => !node.hasAttribute('use') || node.getAttribute('use') === 'signing')
    .flatMap((node) => Array.from(node.getElementsByTagNameNS(NS.ds, 'X509Certificate')))
    .map((node) => {
      const pem = `-----BEGIN CERTIFICATE-----\n${(node.textContent ?? '').replace(/\s/g, '')}\n-----END CERTIFICATE-----`;
      const cert = new X509Certificate(pem);
      requireValue(
        cert.publicKey.asymmetricKeyType === 'rsa' &&
          (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 &&
          Date.parse(cert.validFrom) <= Date.now() &&
          Date.parse(cert.validTo) > Date.now(),
      );
      return cert.toString();
    });
  requireValue(certs.length > 0 && certs.length <= 8);
  return [...new Set(certs)];
}
