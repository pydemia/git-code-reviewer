import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, sign, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import {
  NS,
  PERSISTENT,
  SHA256,
  DIGEST256,
  C14N,
  MAX_XML_BYTES,
  transaction,
  verifyLogin,
  verifyLogoutResponse,
  SamlContractError,
  metadata,
  REDIRECT,
  POST,
  parseXml,
} from './saml-contract.mjs';

export async function certificate(directory, name, domains = []) {
  const keyPath = path.join(directory, `${name}.key`);
  const certPath = path.join(directory, `${name}.crt`);
  const configPath = path.join(directory, `${name}.cnf`);
  await writeFile(
    configPath,
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=${name}\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n${domains.length ? `subjectAltName=${domains.map((domain) => `DNS:${domain}`).join(',')}\nextendedKeyUsage=serverAuth\n` : ''}`,
    { mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-config',
      configPath,
    ],
    { stdio: 'pipe' },
  );
  const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  return { key, cert, keyPath, certPath };
}
const esc = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const instant = (delta) => new Date(Date.now() + delta).toISOString();
export function signedLogin(config, tx, key, cert, changes = {}) {
  const v = {
    responseId: `_${randomBytes(16).toString('hex')}`,
    assertionId: `_${randomBytes(16).toString('hex')}`,
    responseIssuer: config.idpIssuer,
    issuer: config.idpIssuer,
    destination: config.acs,
    requestId: tx.requestId,
    subjectRequestId: tx.requestId,
    recipient: config.acs,
    nameID: 'synthetic-persistent-id',
    nameFormat: PERSISTENT,
    method: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
    audience: config.entityId,
    notBefore: instant(-10_000),
    expires: instant(240_000),
    subjectExpires: instant(240_000),
    sessionExpires: instant(3_600_000),
    sessionIndex: 'synthetic-session',
    issued: instant(0),
    nameQualifier: config.idpIssuer,
    spNameQualifier: config.entityId,
    signatureAlgorithm: SHA256,
    ...changes,
  };
  let xml = `<samlp:Response xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${esc(v.responseId)}" Version="2.0" IssueInstant="${esc(v.issued)}" Destination="${esc(v.destination)}" InResponseTo="${esc(v.requestId)}"><saml:Issuer>${esc(v.responseIssuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="${esc(v.assertionId)}" Version="2.0" IssueInstant="${esc(v.issued)}"><saml:Issuer>${esc(v.issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="${esc(v.nameFormat)}" NameQualifier="${esc(v.nameQualifier)}" SPNameQualifier="${esc(v.spNameQualifier)}">${esc(v.nameID)}</saml:NameID><saml:SubjectConfirmation Method="${esc(v.method)}"><saml:SubjectConfirmationData InResponseTo="${esc(v.subjectRequestId)}" Recipient="${esc(v.recipient)}" NotOnOrAfter="${esc(v.subjectExpires)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${esc(v.notBefore)}" NotOnOrAfter="${esc(v.expires)}"><saml:AudienceRestriction><saml:Audience>${esc(v.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${esc(v.issued)}" SessionIndex="${esc(v.sessionIndex)}" SessionNotOnOrAfter="${esc(v.sessionExpires)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  for (const name of ['Assertion', 'Response']) {
    if (changes[`omit${name}Signature`]) continue;
    const signer = new SignedXml({
      privateKey: key,
      publicCert: cert,
      signatureAlgorithm: v.signatureAlgorithm,
      canonicalizationAlgorithm: C14N,
    });
    const xpath = `//*[local-name()='${name}']`;
    signer.addReference({
      xpath,
      transforms: [`${NS.ds}enveloped-signature`, C14N],
      digestAlgorithm: DIGEST256,
    });
    signer.computeSignature(xml, {
      prefix: 'ds',
      location: { reference: `${xpath}/*[local-name()='Issuer']`, action: 'after' },
    });
    xml = signer.getSignedXml();
  }
  return { xml, encoded: Buffer.from(xml).toString('base64') };
}
export function signedLogout(config, tx, key, changes = {}) {
  const v = {
    id: `_${randomBytes(16).toString('hex')}`,
    destination: config.slo,
    requestId: tx.requestId,
    issuer: config.idpIssuer,
    issued: instant(0),
    ...changes,
  };
  const xml = `<samlp:LogoutResponse xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${v.id}" Version="2.0" IssueInstant="${v.issued}" Destination="${v.destination}" InResponseTo="${v.requestId}"><saml:Issuer>${v.issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`;
  const fields = {
    SAMLResponse: deflateRawSync(xml).toString('base64'),
    RelayState: tx.relayState,
    SigAlg: SHA256,
  };
  const query = Object.entries(fields)
    .map(([k, value]) => `${k}=${encodeURIComponent(value)}`)
    .join('&');
  return `${query}&Signature=${encodeURIComponent(sign('RSA-SHA256', Buffer.from(query), key).toString('base64'))}`;
}
export function signedLogoutRequest(config, key, changes = {}) {
  const v = {
    id: `_${randomBytes(16).toString('hex')}`,
    destination: config.slo,
    issuer: config.idpIssuer,
    issued: instant(0),
    expires: instant(240_000),
    nameID: 'synthetic-persistent-id',
    nameFormat: PERSISTENT,
    nameQualifier: config.idpIssuer,
    spNameQualifier: config.entityId,
    sessionIndexes: ['synthetic-session'],
    relayState: 'synthetic-idp-relay',
    ...changes,
  };
  const xml = `<samlp:LogoutRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${esc(v.id)}" Version="2.0" IssueInstant="${esc(v.issued)}" NotOnOrAfter="${esc(v.expires)}" Destination="${esc(v.destination)}"><saml:Issuer>${esc(v.issuer)}</saml:Issuer><saml:NameID Format="${esc(v.nameFormat)}" NameQualifier="${esc(v.nameQualifier)}" SPNameQualifier="${esc(v.spNameQualifier)}">${esc(v.nameID)}</saml:NameID>${v.sessionIndexes.map((index) => `<samlp:SessionIndex>${esc(index)}</samlp:SessionIndex>`).join('')}</samlp:LogoutRequest>`;
  const fields = {
    SAMLRequest: deflateRawSync(xml).toString('base64'),
    ...(v.relayState === null ? {} : { RelayState: v.relayState }),
    SigAlg: SHA256,
  };
  const query = Object.entries(fields)
    .map(([k, value]) => `${k}=${encodeURIComponent(value)}`)
    .join('&');
  return `${query}&Signature=${encodeURIComponent(sign('RSA-SHA256', Buffer.from(query), key).toString('base64'))}`;
}

export function idpMetadata(config, certs) {
  return `<md:EntityDescriptor xmlns:md="${NS.metadata}" xmlns:ds="${NS.ds}" entityID="${esc(config.idpIssuer)}"><md:IDPSSODescriptor protocolSupportEnumeration="${NS.protocol}">${certs.map((cert) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert.replace(/-----[^-]+-----|\s/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join('')}<md:SingleSignOnService Binding="${REDIRECT}" Location="${esc(config.entryPoint)}"/><md:SingleLogoutService Binding="${REDIRECT}" Location="${esc(config.entryPoint)}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}
// Single-process PoC ledger only. P03-C02 replaces this with PostgreSQL atomic
// transaction + unique-ID consumption; this is not a cross-replica replay proof.
export function consume(ledger, tx, identity) {
  if (
    tx.consumed ||
    ledger.has(identity.responseId) ||
    (identity.assertionId && ledger.has(identity.assertionId))
  ) {
    throw new SamlContractError();
  }
  tx.consumed = true;
  ledger.add(identity.responseId);
  if (identity.assertionId) ledger.add(identity.assertionId);
}

export async function runFixtures() {
  const directory = await mkdtemp(path.join(tmpdir(), 'gcr-saml-unit-'));
  const checks = [];
  const check = async (name, run) => {
    await run();
    checks.push(name);
  };
  try {
    const sp = await certificate(directory, 'sp');
    const idp = await certificate(directory, 'idp');
    const nextIdp = await certificate(directory, 'next-idp');
    const config = {
      acs: 'https://gcr.sp.test/auth/saml/acs',
      slo: 'https://gcr.sp.test/auth/saml/slo',
      entityId: 'https://gcr.sp.test/auth/saml/metadata',
      idpIssuer: 'https://keycloak.idp.test/realms/contract',
      entryPoint: 'https://keycloak.idp.test/realms/contract/protocol/saml',
      privateKey: sp.key,
      publicCert: sp.cert,
      idpCerts: [idp.cert],
    };
    const tx = transaction();
    await check('signed-sp-metadata-matches-implemented-bindings', async () => {
      const xml = metadata(config);
      const doc = parseXml(xml);
      assert.equal(
        doc.getElementsByTagNameNS(NS.metadata, 'SingleLogoutService')[0].getAttribute('Binding'),
        REDIRECT,
      );
      assert.equal(
        doc
          .getElementsByTagNameNS(NS.metadata, 'AssertionConsumerService')[0]
          .getAttribute('Binding'),
        POST,
      );
      const verifier = new SignedXml({ publicCert: sp.cert, getCertFromKeyInfo: () => null });
      verifier.loadSignature(doc.getElementsByTagNameNS(NS.ds, 'Signature')[0]);
      assert.equal(verifier.checkSignature(xml), true);
      assert.equal(verifier.getSignedReferences().length, 1);
      assert.equal(
        parseXml(verifier.getSignedReferences()[0]).documentElement.getAttribute('entityID'),
        config.entityId,
      );
    });
    const good = signedLogin(config, tx, idp.key, idp.cert);
    const identity = await verifyLogin(config, good.encoded, tx);
    assert.equal(identity.nameID, 'synthetic-persistent-id');
    checks.push('signed-response-and-assertion');
    for (const [name, changes] of Object.entries({
      'response-issuer': { responseIssuer: 'https://wrong.test' },
      'assertion-issuer': { issuer: 'https://wrong.test' },
      destination: { destination: 'https://wrong.test/acs' },
      recipient: { recipient: 'https://wrong.test/acs' },
      audience: { audience: 'https://wrong.test/sp' },
      'response-in-response-to': { requestId: '_unknown' },
      'subject-in-response-to': { subjectRequestId: '_unknown' },
      expired: { expires: instant(-120_000) },
      'subject-expired': { subjectExpires: instant(-120_000) },
      'not-yet-valid': { notBefore: instant(120_000) },
      'invalid-date': { expires: 'not-a-date' },
      'old-issue-instant': { issued: instant(-600_000) },
      'session-expired': { sessionExpires: instant(-1000) },
      'non-bearer': { method: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key' },
      'email-nameid': { nameFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' },
      'name-qualifier': { nameQualifier: 'https://wrong.test' },
      'sp-qualifier': { spNameQualifier: 'https://wrong.test' },
      'unsigned-response': { omitResponseSignature: true },
      'unsigned-assertion': { omitAssertionSignature: true },
      'weak-signature': { signatureAlgorithm: `${NS.ds}rsa-sha1` },
    })) {
      await check(name, () =>
        assert.rejects(
          verifyLogin(config, signedLogin(config, tx, idp.key, idp.cert, changes).encoded, tx),
          SamlContractError,
        ),
      );
    }
    for (const [name, xml] of Object.entries({
      'modified-nameid': good.xml.replace('synthetic-persistent-id', 'attacker-id'),
      'duplicate-id': good.xml.replace(
        '<saml:Subject>',
        `<saml:Subject ID="${identity.assertionId}">`,
      ),
      'multiple-assertions': good.xml.replace(
        '</samlp:Response>',
        '<saml:Assertion ID="_extra"/></samlp:Response>',
      ),
      wrapping: good.xml
        .replace('<saml:Assertion ', '<samlp:Extensions><saml:Assertion ')
        .replace('</saml:Assertion>', '</saml:Assertion></samlp:Extensions>'),
      'external-entity': `<!DOCTYPE samlp:Response [<!ENTITY x SYSTEM "file:///etc/passwd">]>${good.xml}`,
      'entity-expansion': `<!DOCTYPE samlp:Response [<!ENTITY a "xxxxxxxx"><!ENTITY b "&a;&a;&a;&a;">]>${good.xml}`,
      'comment-in-nameid': good.xml.replace(
        'synthetic-persistent-id',
        'synthetic-<!--removed-->persistent-id',
      ),
      'oversized-xml': `${' '.repeat(MAX_XML_BYTES)}${good.xml}`,
    })) {
      await check(name, () =>
        assert.rejects(
          verifyLogin(config, Buffer.from(xml).toString('base64'), tx),
          SamlContractError,
        ),
      );
    }
    await check('noncanonical-base64', () =>
      assert.rejects(verifyLogin(config, `${good.encoded}\n`, tx), SamlContractError),
    );
    await check('expired-transaction', () =>
      assert.rejects(
        verifyLogin(config, good.encoded, { ...tx, createdAt: Date.now() - 301_000 }),
        SamlContractError,
      ),
    );
    await check('unsolicited-response', () =>
      assert.rejects(verifyLogin(config, good.encoded, transaction()), SamlContractError),
    );
    const rotated = signedLogin(config, tx, nextIdp.key, nextIdp.cert);
    await check('unapproved-signing-key', () =>
      assert.rejects(verifyLogin(config, rotated.encoded, tx), SamlContractError),
    );
    await check('rotation-overlap', async () => {
      const overlap = { ...config, idpCerts: [idp.cert, nextIdp.cert] };
      await verifyLogin(overlap, good.encoded, tx);
      await verifyLogin(overlap, rotated.encoded, tx);
      await assert.rejects(
        verifyLogin({ ...config, idpCerts: [nextIdp.cert] }, good.encoded, tx),
        SamlContractError,
      );
    });
    await check('same-process-replay-race', async () => {
      const ledger = new Set();
      const results = await Promise.allSettled(
        [0, 1].map(async () => {
          const verified = await verifyLogin(config, good.encoded, tx);
          consume(ledger, tx, verified);
        }),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      await assert.rejects(verifyLogin(config, good.encoded, tx), SamlContractError);
    });
    const logoutTx = transaction('logout');
    const logout = signedLogout(config, logoutTx, idp.key);
    await check('signed-redirect-logout', () => verifyLogoutResponse(config, logout, logoutTx));
    for (const [name, query] of Object.entries({
      'unsigned-logout': logout.replace(/&Signature=.*/, ''),
      'duplicate-logout-parameter': `${logout}&RelayState=attacker`,
      'forged-logout-signature': logout.replace(/&Signature=.*/, '&Signature=AAAA'),
      'wrong-logout-issuer': signedLogout(config, logoutTx, idp.key, {
        issuer: 'https://wrong.test',
      }),
      'wrong-logout-destination': signedLogout(config, logoutTx, idp.key, {
        destination: 'https://wrong.test',
      }),
      'expired-logout': signedLogout(config, logoutTx, idp.key, { issued: instant(-600_000) }),
      'logout-decompression-limit': logout.replace(
        /SAMLResponse=[^&]*/,
        `SAMLResponse=${encodeURIComponent(deflateRawSync('x'.repeat(MAX_XML_BYTES + 1)).toString('base64'))}`,
      ),
    })) {
      await check(name, () =>
        assert.rejects(verifyLogoutResponse(config, query, logoutTx), SamlContractError),
      );
    }
    return {
      status: 'passed',
      phase: 'P03-C01',
      node: process.version,
      checkedAt: new Date().toISOString(),
      sourceSha256: Object.fromEntries(
        await Promise.all(
          [
            '../apps/runtime/src/auth/saml-protocol.ts',
            'saml-contract.mjs',
            'saml-contract-fixtures.mjs',
          ].map(async (name) => [
            name,
            createHash('sha256')
              .update(await readFile(new URL(name, import.meta.url)))
              .digest('hex'),
          ]),
        ),
      ),
      checks,
      count: checks.length,
      fixtureCertificateFingerprint: createHash('sha256').update(idp.cert).digest('hex'),
      limitations: [
        'synthetic signed fixtures',
        'single-process replay ledger; no database or browser',
      ],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runFixtures(), null, 2));
}
