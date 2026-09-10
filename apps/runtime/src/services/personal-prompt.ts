import type { Database } from '@gcr/db';

export async function readPersonalPrompt(database: Pick<Database, 'query'>, userId: string) {
  const result = await database.query<{ personalPrompt: string }>(
    'select personal_prompt as "personalPrompt" from users where id = $1',
    [userId],
  );
  return result.rows[0]?.personalPrompt ?? '';
}
