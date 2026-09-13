import { createHash } from 'node:crypto';
import {
  errorEnvelope,
  localPasswordMaximumLength,
  localPasswordMinimumLength,
  personalPromptUpdateSchema,
  schemaVersion,
} from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser, type AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { hashLocalPassword, verifyLocalPassword } from '../services/local-accounts.js';
import { readPersonalPrompt } from '../services/personal-prompt.js';

const profilePatchBody = z.object({
  displayName: z.string().trim().min(1).max(120),
});
const passwordChangeBody = z.object({
  currentPassword: z.string().min(1).max(localPasswordMaximumLength),
  newPassword: z.string().min(localPasswordMinimumLength).max(localPasswordMaximumLength),
});

type CredentialRow = {
  username: string;
  passwordHash: string;
  passwordChangedAt: Date | string;
};

export async function registerProfileRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
) {
  app.get('/api/v1/profile', { preHandler: requireUser }, async (request) => {
    const [credential, personalPrompt] = await Promise.all([
      findLocalCredential(database, request.user!.id),
      readPersonalPrompt(database, request.user!.id),
    ]);
    return profileView(request.user!, config, credential, personalPrompt);
  });

  app.put('/api/v1/profile/prompt', { preHandler: requireUser }, async (request, reply) => {
    const parsed = personalPromptUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      await writeAudit(database, request, 'user.prompt.update', 'failure');
      throw parsed.error;
    }
    const connection = await database.connect();
    try {
      await connection.query('begin');
      const result = await connection.query<{ personalPrompt: string }>(
        `update users set personal_prompt = $2, updated_at = clock_timestamp()
         where id = $1 and enabled returning personal_prompt as "personalPrompt"`,
        [request.user!.id, parsed.data.personalPrompt],
      );
      await writeAudit(
        connection,
        request,
        'user.prompt.update',
        result.rowCount ? 'success' : 'failure',
      );
      await connection.query('commit');
      if (!result.rows[0])
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '사용자를 찾을 수 없습니다.', request.id));
      return { schemaVersion, personalPrompt: result.rows[0].personalPrompt };
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  });

  app.patch('/api/v1/profile', { preHandler: requireUser }, async (request, reply) => {
    const parsed = profilePatchBody.safeParse(request.body);
    if (!parsed.success) {
      await writeAudit(database, request, 'user.profile.update', 'failure');
      throw parsed.error;
    }
    if (config.AUTH_MODE !== 'local') {
      await writeAudit(database, request, 'user.profile.update', 'failure');
      return externallyManaged(request, reply, 'profile');
    }
    const connection = await database.connect();
    try {
      await connection.query('begin');
      const result = await connection.query<{ displayName: string }>(
        `update users app_user set display_name = $2, updated_at = clock_timestamp()
         where app_user.id = $1
           and exists (select 1 from local_credentials credential where credential.user_id = app_user.id)
         returning app_user.display_name as "displayName"`,
        [request.user!.id, parsed.data.displayName],
      );
      if (!result.rows[0]) {
        await writeAudit(connection, request, 'user.profile.update', 'failure');
        await connection.query('commit');
        return externallyManaged(request, reply, 'profile');
      }
      const credential = await findLocalCredential(connection, request.user!.id);
      const personalPrompt = await readPersonalPrompt(connection, request.user!.id);
      await writeAudit(connection, request, 'user.profile.update', 'success');
      await connection.query('commit');
      return profileView(
        { ...request.user!, displayName: result.rows[0].displayName },
        config,
        credential,
        personalPrompt,
      );
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  });

  app.put('/api/v1/profile/password', { preHandler: requireUser }, async (request, reply) => {
    const parsed = passwordChangeBody.safeParse(request.body);
    if (!parsed.success) {
      await writeAudit(database, request, 'user.password.change', 'failure');
      throw parsed.error;
    }
    if (config.AUTH_MODE !== 'local') {
      await writeAudit(database, request, 'user.password.change', 'failure');
      return externallyManaged(request, reply, 'password');
    }
    const body = parsed.data;
    const connection = await database.connect();
    try {
      await connection.query('begin');
      const credential = await findLocalCredential(connection, request.user!.id, true);
      if (!credential) {
        await writeAudit(connection, request, 'user.password.change', 'failure');
        await connection.query('commit');
        return externallyManaged(request, reply, 'password');
      }
      const attemptKey = credentialAttemptKey(credential.username);
      if (await passwordVerificationLimited(connection, attemptKey)) {
        await writeAudit(connection, request, 'user.password.change', 'failure');
        await connection.query('commit');
        return reply
          .code(429)
          .send(
            errorEnvelope(
              'PASSWORD_VERIFICATION_LIMITED',
              '현재 비밀번호 확인이 일시적으로 제한됐습니다. 15분 후 다시 시도해 주세요.',
              request.id,
              true,
            ),
          );
      }
      if (!(await verifyLocalPassword(body.currentPassword, credential.passwordHash))) {
        await recordPasswordVerificationFailure(connection, attemptKey);
        await writeAudit(connection, request, 'user.password.change', 'failure');
        await connection.query('commit');
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'CURRENT_PASSWORD_INVALID',
              '현재 비밀번호가 올바르지 않습니다.',
              request.id,
            ),
          );
      }
      if (body.currentPassword === body.newPassword) {
        await connection.query('delete from local_login_limits where username_hash = $1', [
          attemptKey,
        ]);
        await writeAudit(connection, request, 'user.password.change', 'failure');
        await connection.query('commit');
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'PASSWORD_UNCHANGED',
              '현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.',
              request.id,
            ),
          );
      }
      const passwordHash = await hashLocalPassword(body.newPassword);
      await connection.query(
        `update local_credentials set password_hash = $2,
           password_changed_at = clock_timestamp(), updated_at = clock_timestamp()
         where user_id = $1`,
        [request.user!.id, passwordHash],
      );
      await connection.query('delete from local_login_limits where username_hash = $1', [
        attemptKey,
      ]);
      await connection.query('delete from user_sessions where user_id = $1', [request.user!.id]);
      await writeAudit(connection, request, 'user.password.change', 'success');
      await connection.query('commit');
      reply.clearCookie('gcr_session', { path: '/' });
      return { schemaVersion, reauthenticate: true };
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  });
}

async function findLocalCredential(
  database: Pick<Database, 'query'>,
  userId: string,
  forUpdate = false,
): Promise<CredentialRow | null> {
  const result = await database.query<CredentialRow>(
    `select username, password_hash as "passwordHash",
            password_changed_at as "passwordChangedAt"
     from local_credentials where user_id = $1${forUpdate ? ' for update' : ''}`,
    [userId],
  );
  return result.rows[0] ?? null;
}

function profileView(
  user: AuthUser,
  config: AppConfig,
  credential: CredentialRow | null,
  personalPrompt: string,
) {
  const local = credential !== null;
  return {
    schemaVersion,
    id: user.id,
    subject: user.subject,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled,
    tenants: user.tenants,
    identityType:
      config.AUTH_MODE === 'saml'
        ? ('saml' as const)
        : local
          ? ('local' as const)
          : ('external' as const),
    username: config.AUTH_MODE === 'saml' ? null : (credential?.username ?? null),
    profileEditable: local && config.AUTH_MODE === 'local',
    passwordChangeAllowed: local && config.AUTH_MODE === 'local',
    passwordChangedAt:
      credential && config.AUTH_MODE === 'local'
        ? new Date(credential.passwordChangedAt).toISOString()
        : null,
    personalPrompt,
  };
}

function externallyManaged(
  request: FastifyRequest,
  reply: FastifyReply,
  target: 'profile' | 'password',
) {
  return reply
    .code(409)
    .send(
      errorEnvelope(
        target === 'password' ? 'PASSWORD_MANAGED_EXTERNALLY' : 'PROFILE_MANAGED_EXTERNALLY',
        target === 'password'
          ? '이 계정의 비밀번호는 연결된 Identity Provider에서 변경해 주세요.'
          : '이 계정의 프로필은 연결된 Identity Provider에서 관리됩니다.',
        request.id,
      ),
    );
}

function credentialAttemptKey(username: string): string {
  return createHash('sha256').update(username).digest('hex');
}

async function passwordVerificationLimited(
  database: Pick<Database, 'query'>,
  attemptKey: string,
): Promise<boolean> {
  const result = await database.query<{ limited: boolean }>(
    `select coalesce(locked_until > clock_timestamp(), false) as limited
     from local_login_limits where username_hash = $1`,
    [attemptKey],
  );
  return result.rows[0]?.limited ?? false;
}

async function recordPasswordVerificationFailure(
  database: Pick<Database, 'query'>,
  attemptKey: string,
) {
  await database.query(
    `insert into local_login_limits(username_hash, failed_count)
     values ($1, 1)
     on conflict (username_hash) do update set
       failed_count = case
         when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
           then 1
         else local_login_limits.failed_count + 1
       end,
       window_started_at = case
         when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
           then clock_timestamp()
         else local_login_limits.window_started_at
       end,
       locked_until = case
         when (
           case
             when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
               then 1
             else local_login_limits.failed_count + 1
           end
         ) >= 5 then clock_timestamp() + interval '15 minutes'
         else local_login_limits.locked_until
       end,
       updated_at = clock_timestamp()`,
    [attemptKey],
  );
}

async function writeAudit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  outcome: 'success' | 'failure',
) {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id)
     values ($1, $2, 'user', $3, $4, $5)`,
    [request.user!.subject, action, request.user!.id, outcome, request.id],
  );
}
