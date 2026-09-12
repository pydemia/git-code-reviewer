import { randomUUID } from 'node:crypto';
import {
  localKnowledge,
  type LocalKnowledge,
  type LocalMemory,
  type LocalSkill,
} from '@gcr/client-contract';
import { canonicalJson, contentHash } from './local-identity.js';
import { LocalStoreError } from './local-errors.js';
import { LocalRecordStore } from './local-records.js';
import { publishImmutable } from './private-files.js';

type Generated = 'id' | 'scope' | 'revision' | 'hash' | 'state' | 'createdAt' | 'updatedAt';
export type LocalKnowledgeDraft = Omit<LocalMemory, Generated> | Omit<LocalSkill, Generated>;
export type LocalKnowledgeEdit = Partial<
  Pick<LocalKnowledge, 'title' | 'body' | 'appliesTo' | 'sources'>
> &
  Partial<Pick<LocalMemory, 'rationale' | 'counterEvidence'>> & {
    /** null explicitly removes an existing expiry. */
    expiresAt?: string | null;
  };
function withHash(value: Omit<LocalKnowledge, 'hash'>): LocalKnowledge {
  return localKnowledge({ ...value, hash: contentHash(value) });
}
function verify(value: unknown): LocalKnowledge {
  const item = localKnowledge(value);
  const { hash, ...body } = item;
  if (hash !== contentHash(body))
    throw new LocalStoreError(
      'corrupt-storage',
      'Local knowledge content does not match its hash.',
    );
  return item;
}
const immutable = new Set([
  'id',
  'scope',
  'revision',
  'hash',
  'state',
  'createdAt',
  'updatedAt',
  'kind',
  'reviewOnly',
  'origin',
]);

/** User-owned knowledge only. Central cache and upload are separate services. */
export class LocalKnowledgeStore {
  constructor(
    private readonly records: LocalRecordStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private timestamp(): string {
    return this.now().toISOString();
  }
  async get(id: string): Promise<LocalKnowledge | undefined> {
    const record = await this.records.read('knowledge', id);
    if (!record || record.deleted) return undefined;
    const item = verify(record.value);
    if (
      item.id !== id ||
      item.revision !== record.revision ||
      canonicalJson(item.scope) !== canonicalJson(this.records.scope)
    )
      throw new LocalStoreError(
        'corrupt-storage',
        'Local knowledge identity does not match its storage scope.',
      );
    return item;
  }
  async list(): Promise<LocalKnowledge[]> {
    const items: LocalKnowledge[] = [];
    for (const id of await this.records.listIds('knowledge')) {
      const item = await this.get(id);
      if (item) items.push(item);
    }
    return items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  async active(): Promise<LocalKnowledge[]> {
    const now = this.timestamp();
    return (await this.list()).filter(
      (item) => item.state === 'active' && (!item.expiresAt || item.expiresAt > now),
    );
  }
  create(draft: LocalKnowledgeDraft): Promise<LocalKnowledge> {
    return this.insert(draft);
  }
  private async insert(draft: LocalKnowledgeDraft, createdAt?: string): Promise<LocalKnowledge> {
    // Imported or model-derived content always begins as a candidate. Activation is a separate action.
    const now = this.timestamp();
    const item = withHash({
      ...draft,
      id: randomUUID(),
      scope: this.records.scope,
      revision: 1,
      state: 'candidate',
      createdAt: createdAt ?? now,
      updatedAt: now,
    });
    await this.records.write('knowledge', item.id, item, 0);
    return item;
  }
  private async current(id: string, revision: number): Promise<LocalKnowledge> {
    const current = await this.get(id);
    if (!current || current.revision !== revision)
      throw new LocalStoreError(
        'revision-conflict',
        'Local knowledge changed. Reload it before applying this edit.',
      );
    return current;
  }
  private async replace(
    current: LocalKnowledge,
    changes: Record<string, unknown>,
  ): Promise<LocalKnowledge> {
    const body = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== 'hash'),
    ) as Omit<LocalKnowledge, 'hash'>;
    const next = {
      ...body,
      ...changes,
      revision: current.revision + 1,
      updatedAt: this.timestamp(),
    };
    if (changes.expiresAt === null) delete next.expiresAt;
    const item = withHash(next);
    await this.records.write('knowledge', item.id, item, current.revision);
    return item;
  }
  async edit(id: string, revision: number, changes: LocalKnowledgeEdit): Promise<LocalKnowledge> {
    // Copy before awaiting storage, so editor-owned buffers cannot change a pending write.
    const copied = JSON.parse(canonicalJson(changes)) as Record<string, unknown>;
    const current = await this.current(id, revision);
    const allowed = new Set([
      'title',
      'body',
      'appliesTo',
      'sources',
      'expiresAt',
      ...(current.kind === 'memory' ? ['rationale', 'counterEvidence'] : []),
    ]);
    if (Object.keys(copied).some((key) => immutable.has(key) || !allowed.has(key)))
      throw new LocalStoreError(
        'corrupt-storage',
        'Knowledge edit contains a field that cannot be changed.',
      );
    return this.replace(current, copied);
  }
  async setState(
    id: string,
    revision: number,
    state: LocalKnowledge['state'],
  ): Promise<LocalKnowledge> {
    return this.replace(await this.current(id, revision), { state });
  }
  async remove(
    id: string,
    revision: number,
  ): Promise<{ revision: number; cleanupPending: boolean }> {
    await this.current(id, revision);
    return this.records.remove('knowledge', id, revision);
  }
  async exportKnowledge(id: string): Promise<string> {
    const item = await this.get(id);
    if (!item) throw new LocalStoreError('revision-conflict', 'Local knowledge no longer exists.');
    return canonicalJson(item) + '\n';
  }
  /** Explicit plaintext export to a new user-chosen file; never replace an existing file. */
  async exportFile(id: string, file: string): Promise<void> {
    const bytes = Buffer.from(await this.exportKnowledge(id));
    try {
      if (!(await publishImmutable(file, bytes)))
        throw new LocalStoreError(
          'revision-conflict',
          'Export file already exists. Choose a new file.',
        );
    } finally {
      bytes.fill(0);
    }
  }
  async importKnowledge(value: unknown): Promise<LocalKnowledge> {
    const item = verify(value);
    const draft = Object.fromEntries(
      Object.entries(item).filter(
        ([key]) =>
          !['id', 'scope', 'revision', 'hash', 'state', 'createdAt', 'updatedAt'].includes(key),
      ),
    );
    draft.sources = [
      ...item.sources,
      { kind: 'import', label: 'Explicit local knowledge import', hash: contentHash(item) },
    ];
    // Scope and identity are assigned by create; an import never opens another profile's store.
    return this.insert(draft as LocalKnowledgeDraft, item.createdAt);
  }
}
