import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { knowledgeAudience, type KnowledgeAudience } from '@gcr/client-contract';
import { canonicalJson } from './local-identity.js';
export class KnowledgeSyncError extends Error {
  constructor(
    readonly code:
      | 'invalid-binding'
      | 'repository-mismatch'
      | 'busy'
      | 'disabled'
      | 'authentication-required'
      | 'revoked'
      | 'unavailable'
      | 'identity-unavailable'
      | 'incompatible'
      | 'invalid-manifest'
      | 'invalid-bundle'
      | 'cache-unavailable'
      | 'superseded'
      | 'cancelled'
      | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeSyncError';
  }
}
const invalid = () =>
  new KnowledgeSyncError(
    'invalid-binding',
    'Explicit trusted server, audience and Ed25519 keys are required.',
  );
export function normalizeCentralServerUrl(input: string, allowLoopbackHttp = false): string {
  try {
    if (input !== input.trim() || /[\\\s]/.test(input)) throw invalid();
    const raw = /^(https?):\/\/[^/?#]+([^?#]*)$/.exec(input);
    if (!raw) throw invalid();
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash) throw invalid();
    if (
      url.protocol !== 'https:' &&
      !(
        allowLoopbackHttp &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      throw invalid();
    const segments = raw[2]!.split('/').slice(1);
    if (segments.at(-1) === '') segments.pop();
    if (segments.some((segment) => !segment)) throw invalid();
    const decoded = segments.map((segment) => {
      const value = decodeURIComponent(segment);
      if (
        value === '.' ||
        value === '..' ||
        /[\\/%]/.test(value) ||
        [...value].some((char) => char.codePointAt(0)! <= 0x20 || char.codePointAt(0) === 0x7f)
      )
        throw invalid();
      return encodeURIComponent(value);
    });
    url.pathname = '/' + (decoded.length ? decoded.join('/') + '/' : '');
    return url.toString();
  } catch {
    throw invalid();
  }
}
export type CentralBindingInput = {
  serverUrl: string;
  audience: KnowledgeAudience;
  trustedKeys: ReadonlyMap<string, string | KeyObject>;
  allowLoopbackHttp?: boolean;
};
/** The host obtains the audience through explicit authenticated repository selection. No discovery/network occurs here. */
export class TrustedCentralBinding {
  readonly serverUrl: string;
  readonly audience: Readonly<KnowledgeAudience>;
  readonly id: string;
  #keys: Map<string, KeyObject>;
  constructor(input: CentralBindingInput) {
    this.serverUrl = normalizeCentralServerUrl(input.serverUrl, input.allowLoopbackHttp);
    try {
      this.audience = Object.freeze(knowledgeAudience(input.audience));
      this.#keys = new Map();
      if (!input.trustedKeys.size || input.trustedKeys.size > 16) throw invalid();
      for (const [id, value] of input.trustedKeys) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw invalid();
        const key = typeof value === 'string' ? createPublicKey(value) : value;
        if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw invalid();
        this.#keys.set(id, createPublicKey(key.export({ type: 'spki', format: 'pem' })));
      }
      // Keys can rotate without resetting persisted replay floors for the same identity.
      this.id = createHash('sha256')
        .update(canonicalJson({ serverUrl: this.serverUrl, audience: this.audience }))
        .digest('hex');
      Object.freeze(this);
    } catch {
      throw invalid();
    }
  }
  verificationKeys(): ReadonlyMap<string, KeyObject> {
    return new Map(this.#keys);
  }
}
