import type { DatabaseClient } from '@gcr/db';

// 접근 변경과 삭제를 직렬화하고, 요청 인증 이후 회수된 관리자 권한도 다시 확인한다.
export async function lockUserAdministration(connection: DatabaseClient, actorId: string) {
  await connection.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
  const actor = await connection.query(
    `select id from users where id = $1 and role = 'administrator'
       and enabled and deleted_at is null for update`,
    [actorId],
  );
  return Boolean(actor.rowCount);
}

export async function hasOtherAdministrator(connection: DatabaseClient, userId: string) {
  const result = await connection.query(
    `select id from users where id <> $1 and role = 'administrator'
       and enabled and deleted_at is null limit 1`,
    [userId],
  );
  return Boolean(result.rowCount);
}
