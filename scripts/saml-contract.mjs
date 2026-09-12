// Isolated P03-C01 adoption contract. Not registered in the application server.
import { SAML } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { randomBytes, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

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
function requireValue(condition) {
  if (!condition) throw new SamlContractError();
}
export function elements(node, namespace, name) {
  return Array.from(node.childNodes ?? []).filter(
    (child) => child.nodeType === 1 && child.namespaceURI === namespace && child.localName === name,
  );
}
export function one(node, namespace, name) {
  const found = elements(node, namespace, name);
  requireValue(found.length === 1);
  return found[0];
}
function text(node) {
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
function attr(node, name) {
  const value = node.getAttribute(name);
  requireValue(value && value.length <= 4096);
  return value;
}
export function parseXml(xml) {
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
function decodeBase64(encoded) {
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
function rootElement(doc, namespace, name) {
  const root = doc.documentElement;
  requireValue(root.namespaceURI === namespace && root.localName === name);
  return root;
}
function timestamp(node, name) {
  const raw = attr(node, name);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw));
  const value = Date.parse(raw);
  requireValue(Number.isFinite(value));
  return value;
}
function recent(node, now) {
  requireValue(attr(node, 'Version') === '2.0');
  attr(node, 'ID');
  const issued = timestamp(node, 'IssueInstant');
  requireValue(issued <= now + CLOCK_SKEW_MS && now - issued < TRANSACTION_MS + CLOCK_SKEW_MS);
}
function signatureProfile(node) {
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
      attr(transforms[0], 'Algorithm') === `${NS.ds}enveloped-signature` &&
      attr(transforms[1], 'Algorithm') === C14N,
  );
  requireValue(
    signature.getElementsByTagNameNS(NS.ds, 'Object').length === 0 &&
      signature.getElementsByTagNameNS(NS.ds, 'RetrievalMethod').length === 0,
  );
}
function assertTransaction(tx, now, kind) {
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
function makeSaml(config, tx) {
  return new SAML({
    callbackUrl: config.acs,
    issuer: config.entityId,
    audience: config.entityId,
    idpIssuer: config.idpIssuer,
    entryPoint: config.entryPoint,
    logoutUrl: config.entryPoint,
    logoutCallbackUrl: config.slo,
    idpCert: config.idpCerts,
    privateKey: config.privateKey,
    publicCert: config.publicCert,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    xmlSignatureTransforms: [`${NS.ds}enveloped-signature`, C14N],
    identifierFormat: PERSISTENT,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: 'always',
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
export function transaction(kind = 'login') {
  return {
    kind,
    requestId: `_${randomBytes(24).toString('hex')}`,
    nonce: randomBytes(32).toString('base64url'),
    relayState: randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    consumed: false,
  };
}
export async function loginUrl(config, tx) {
  assertTransaction(tx, Date.now(), 'login');
  return makeSaml(config, tx).getAuthorizeUrlAsync(tx.relayState, undefined, {});
}
export function metadata(config) {
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
export async function verifyLogin(config, encoded, tx) {
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
    ]) {
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
export async function logoutUrl(config, tx, identity) {
  assertTransaction(tx, Date.now(), 'logout');
  return makeSaml(config, tx).getLogoutUrlAsync(
    {
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
export async function verifyLogoutResponse(config, rawQuery, tx) {
  try {
    assertTransaction(tx, Date.now(), 'logout');
    requireValue(typeof rawQuery === 'string' && rawQuery.length < MAX_XML_BYTES);
    const params = new URLSearchParams(rawQuery);
    const keys = ['SAMLResponse', 'RelayState', 'SigAlg', 'Signature'];
    requireValue(
      Array.from(params.keys()).length === keys.length &&
        keys.every((k) => params.getAll(k).length === 1),
    );
    requireValue(params.get('SigAlg') === SHA256 && params.get('RelayState') === tx.relayState);
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
    requireValue(params.get('Signature').length > 0);
    const result = await makeSaml(config, tx).validateRedirectAsync(
      Object.fromEntries(params),
      rawQuery,
    );
    requireValue(result.loggedOut && result.profile === null);
    return { responseId: attr(root, 'ID'), requestId: tx.requestId };
  } catch {
    throw new SamlContractError();
  }
}

// The PoC caller obtains this document from an explicitly approved HTTPS URL
// outside the response handler. These certificates are never sourced from SAML.
export function parseIdpMetadata(xml, { issuer, entryPoint }) {
  const root = rootElement(parseXml(xml), NS.metadata, 'EntityDescriptor');
  requireValue(attr(root, 'entityID') === issuer);
  const descriptor = one(root, NS.metadata, 'IDPSSODescriptor');
  for (const name of ['SingleSignOnService', 'SingleLogoutService']) {
    const endpoint = elements(descriptor, NS.metadata, name).filter(
      (node) => node.getAttribute('Binding') === REDIRECT,
    );
    requireValue(endpoint.length === 1 && attr(endpoint[0], 'Location') === entryPoint);
  }
  const certs = elements(descriptor, NS.metadata, 'KeyDescriptor')
    .filter((node) => !node.hasAttribute('use') || node.getAttribute('use') === 'signing')
    .flatMap((node) => Array.from(node.getElementsByTagNameNS(NS.ds, 'X509Certificate')))
    .map((node) => {
      const pem = `-----BEGIN CERTIFICATE-----\n${node.textContent.replace(/\s/g, '')}\n-----END CERTIFICATE-----`;
      const cert = new X509Certificate(pem);
      requireValue(
        cert.publicKey.asymmetricKeyType === 'rsa' &&
          cert.publicKey.asymmetricKeyDetails.modulusLength >= 2048 &&
          Date.parse(cert.validFrom) <= Date.now() &&
          Date.parse(cert.validTo) > Date.now(),
      );
      return cert.toString();
    });
  requireValue(certs.length > 0 && certs.length <= 8);
  return [...new Set(certs)];
}
