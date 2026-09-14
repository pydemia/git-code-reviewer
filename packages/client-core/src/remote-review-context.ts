import { createHash } from 'node:crypto';
import {
  canonicalKnowledgeJson,
  KNOWLEDGE_CLIENT_CONTRACT_VERSION,
  contextIdentity,
  type CentralKnowledgeBundle,
  type SignedKnowledgeManifest,
} from '@gcr/client-contract';
import { builtinReviewSkill } from './builtin-review.js';
import { contentHash, canonicalJson } from './local-identity.js';
import { remoteReviewContextHash, validateRemoteReviewPayload } from './remote-review.js';
import { restoreRemoteReviewSource } from './remote-review-source.js';
import { selectCentralKnowledge } from './central-selection.js';
import {
  LocalReviewContext,
  type LocalContextResolution,
  type ContextSourceRequirement,
} from './review-context.js';

/** Supplied by the server's authenticated manifest/artifact service, never by uploaded JSON. */
export interface RemoteReviewContextAuthority {
  load(
    manifest: SignedKnowledgeManifest,
  ): Promise<Record<'policy' | 'collective' | 'personal', CentralKnowledgeBundle>>;
  observe(manifest: SignedKnowledgeManifest): Promise<'current' | 'updated' | 'pending'>;
}

/** Restore the selected materials without scanning stores, updating knowledge, or obtaining new approval. */
export async function restoreRemoteReviewContext(
  input: unknown,
  options: {
    authority?: RemoteReviewContextAuthority;
    now?: Date;
  } = {},
): Promise<LocalContextResolution> {
  let source: ReturnType<typeof restoreRemoteReviewSource> | undefined;
  try {
    const payload = validateRemoteReviewPayload(input),
      selected = payload.context.resolved;
    if (!selected) throw Error('missing-approved-context');
    const now = (options.now ?? new Date()).toISOString();
    if (
      contentHash(selected.builtin) !==
      contentHash({
        id: builtinReviewSkill.id,
        revision: builtinReviewSkill.revision,
        hash: builtinReviewSkill.hash,
      })
    )
      throw Error('builtin-version-unavailable');
    source = restoreRemoteReviewSource(payload);
    const requirements = [...selected.requiredSources];
    for (const change of source.selected) {
      requirements.push({ path: change.path, side: change.side });
      const basePath = change.oldPath ?? change.path;
      if (change.side === 'source' && source.readFile(basePath, 'base').status !== 'absent')
        requirements.push({ path: basePath, side: 'base' });
    }
    const sources: ContextSourceRequirement[] = [
      ...new Map(requirements.map((item) => [`${item.side}:${item.path}`, item])).values(),
    ]
      .map((item) => {
        const available = source!.readFile(item.path, item.side).status === 'available';
        return {
          ...item,
          reference: `source:${contentHash(item)}`,
          available,
          reason: available ? '' : 'Required source is not included in the approved upload.',
        };
      })
      .sort((a, b) => a.reference.localeCompare(b.reference));
    if (selected.knowledge.some((item) => item.state !== 'active'))
      throw Error('inactive-approved-knowledge');
    const pin = selected.central;
    let central: ReturnType<typeof selectCentralKnowledge> | undefined;
    let observe: (() => Promise<'current' | 'updated' | 'pending'>) | undefined;
    if (pin) {
      const authority = options.authority;
      if (
        !authority ||
        pin.manifest.payload.compatibleClientContracts.minimum >
          KNOWLEDGE_CLIENT_CONTRACT_VERSION ||
        pin.manifest.payload.compatibleClientContracts.maximum <
          KNOWLEDGE_CLIENT_CONTRACT_VERSION ||
        pin.selection.now < pin.manifest.payload.issuedAt ||
        Date.parse(pin.selection.now) > Date.parse(now) + 60000
      )
        throw Error('central-authority-unavailable');
      observe = () => authority.observe(pin.manifest);
      if ((await observe()) !== 'current') throw Error('approved-central-snapshot-unavailable');
      const bundles = await authority.load(pin.manifest);
      for (const part of ['policy', 'collective', 'personal'] as const) {
        const bundle = bundles[part],
          descriptor = pin.manifest.payload.components[part];
        const bytes = canonicalKnowledgeJson(bundle);
        if (
          createHash('sha256').update(bytes).digest('hex') !== descriptor.contentHash ||
          Buffer.byteLength(bytes) !== descriptor.sizeBytes ||
          bundle.component !== part ||
          bundle.tenantId !== payload.audience.tenantId ||
          bundle.repositoryId !== payload.audience.repositoryId ||
          bundle.ownerUserId !== (part === 'personal' ? payload.audience.userId : null)
        )
          throw Error('central-bundle-mismatch');
      }
      central = selectCentralKnowledge({
        bundles,
        ...pin.selection,
        selected: source.selected.flatMap((change) => {
          const file = source!.readFile(change.path, change.side);
          return file.status === 'available' ? [file] : [];
        }),
      });
      if (contentHash(central) !== pin.selectionHash || (await observe()) !== 'current')
        throw Error('approved-central-selection-changed');
    }
    const validUntil =
      [
        selected.validUntil,
        ...selected.knowledge.map((item) => item.expiresAt),
        pin?.manifest.payload.refreshAfter,
        central?.validUntil,
      ]
        .filter((at): at is string => !!at)
        .sort()[0] ?? null;
    if (validUntil && validUntil <= now) throw Error('approved-context-expired');
    const documents = payload.context.documents;
    const bytes =
      Buffer.byteLength(canonicalJson(builtinReviewSkill)) +
      (central?.bytes ?? 0) +
      selected.knowledge.reduce(
        (total, item) => total + Buffer.byteLength(canonicalJson(item)),
        0,
      ) +
      documents.reduce((total, item) => total + Buffer.byteLength(canonicalJson(item)), 0);
    if (bytes > 1048576) throw Error('approved-context-too-large');
    const identity = contextIdentity({
      hash: remoteReviewContextHash(payload),
      entries: [
        { origin: 'builtin', kind: 'skill', ...selected.builtin },
        ...selected.knowledge.map((item) => ({
          origin: 'local',
          kind: item.kind,
          id: item.id,
          revision: item.revision,
          hash: item.hash,
          scope: item.scope,
        })),
        ...(central?.entries ?? []),
      ],
      required: [
        {
          kind: 'knowledge',
          reference: `builtin:${builtinReviewSkill.id}`,
          available: true,
          reason: '',
        },
        ...sources.map((item) => ({
          kind: 'source',
          reference: item.reference,
          available: item.available,
          reason: item.reason,
        })),
        ...selected.knowledge.map((item) => ({
          kind: 'knowledge',
          reference: `knowledge:${item.id}`,
          available: true,
          reason: '',
        })),
        ...(central?.required ?? []),
      ],
      ...(pin
        ? {
            centralSnapshot: {
              id: pin.manifest.payload.snapshotId,
              hash: pin.manifest.manifestHash,
              audience: pin.manifest.payload.audience,
              authorizationRevision: String(pin.manifest.payload.authorizationRevision),
              offlineValidUntil: pin.manifest.payload.offlineValidUntil,
            },
          }
        : {}),
    });
    const problems = identity.required.some((item) => !item.available)
      ? [
          {
            code: 'missing-context' as const,
            message: 'Required approved review context is unavailable.',
          },
        ]
      : [];
    return {
      status: problems.length ? 'needs-context' : 'ready',
      problems,
      context: new LocalReviewContext(
        {
          client: payload.client,
          sourceHash: source.identity.hash,
          identity,
          knowledge: selected.knowledge,
          documents,
          builtin: builtinReviewSkill,
          bytes,
          omissions: [],
          sources,
          validUntil,
          transferable: problems.length === 0,
          ...(central ? { central, centralTransfer: pin } : {}),
        },
        observe,
      ),
    };
  } catch {
    return {
      status: 'unavailable',
      problems: [
        {
          code: 'missing-context',
          message: 'Approved review context could not be restored or authorized.',
        },
      ],
    };
  } finally {
    source?.close();
  }
}
