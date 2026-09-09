import type { Database } from '@gcr/db';

export async function deleteRegistryEntry(
  database: Database,
  kind: 'chat_account' | 'analysis_provider',
  id: string,
  confirmation: string,
  actor: string,
  requestId: string,
): Promise<'deleted' | 'not-found' | 'active' | 'in-use' | 'confirmation'> {
  const client = await database.connect();
  try {
    await client.query('begin');
    // Provider 활성화와 account 삭제 사이의 참조 경쟁도 같은 lock으로 직렬화한다.
    await client.query("select pg_advisory_xact_lock(hashtextextended('analysis-provider', 0))");
    const account = kind === 'chat_account';
    const result = await client.query<{ active: boolean; identity: string }>(
      account
        ? 'select enabled as active, display_name as identity from chat_accounts where id=$1 and deleted_at is null for update'
        : "select active, 'v' || version as identity from analysis_provider_versions where id=$1 and deleted_at is null for update",
      [id],
    );
    const row = result.rows[0];
    let blocked: 'not-found' | 'active' | 'in-use' | 'confirmation' | null = !row
      ? 'not-found'
      : row.identity !== confirmation
        ? 'confirmation'
        : row.active
          ? 'active'
          : null;
    if (!blocked && account) {
      const references = await client.query(
        `select 1 from analysis_provider_versions
        where chat_account_id=$1 and active
        union all select 1 from analysis_runs run join analysis_provider_versions provider
          on provider.id=run.provider_version_id where provider.chat_account_id=$1
          and run.state in ('queued','analyzing')
        union all select 1 from chat_runs where configuration->>'accountId'=$1::text
          and status in ('queued','running','awaiting_input','waiting_capacity','cancelling') limit 1`,
        [id],
      );
      if (references.rowCount) blocked = 'in-use';
    }
    if (blocked) {
      await client.query('rollback');
      return blocked;
    }
    if (account) {
      await client.query(
        `update chat_accounts set deleted_at=clock_timestamp(), updated_at=clock_timestamp(),
        health='disabled', credential_ciphertext=null, credential_iv=null, credential_auth_tag=null where id=$1`,
        [id],
      );
      await client.query(
        'update chat_account_assignments set enabled=false,updated_at=clock_timestamp() where account_id=$1',
        [id],
      );
      await client.query('update chat_account_models set enabled=false where account_id=$1', [id]);
    } else {
      await client.query(
        'update analysis_provider_versions set deleted_at=clock_timestamp() where id=$1',
        [id],
      );
    }
    await client.query(
      `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id)
      values($1,$2,$3,$4,'success',$5)`,
      [actor, `${kind}.delete`, kind, id, requestId],
    );
    await client.query('commit');
    return 'deleted';
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export const registryDeletionMessages = {
  'not-found': '삭제할 항목을 찾을 수 없습니다.',
  active: '비활성 항목만 삭제할 수 있습니다. 먼저 비활성화해 주세요.',
  'in-use':
    '대기·진행 중인 분석과 대화를 완료하거나 중단한 뒤, 이 account를 사용하는 활성 Provider를 변경해 주세요.',
  confirmation: '삭제할 항목의 이름이 일치하지 않습니다. 목록을 새로고침해 주세요.',
} as const;
