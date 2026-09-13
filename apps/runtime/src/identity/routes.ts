import {
  errorEnvelope,
  identityProvisioningRequest,
  identityLifecycleRequest,
  schemaVersion,
  type IdentityOperationView,
} from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { requireAdministrator } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import { identityAdministrationConfig } from './config.js';
import { KeycloakAdminClient, KeycloakAdminError } from './keycloak-admin.js';
import { requestIdentityLifecycle, retryIdentityReactivation } from './lifecycle.js';
import {
  IdentityOperationError,
  requestIdentityProvisioning,
  retryIdentityOperation,
  type IdentityOperation,
} from './operations.js';

const operationParams = z.object({ operationId: z.string().uuid() });
const previewBody = z.object({ keycloakUserId: z.string().uuid() }).strict();
export function identityOperationView(row: IdentityOperation): IdentityOperationView {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    state: row.state,
    username: row.requested_username,
    email: row.requested_email,
    displayName: row.requested_display_name,
    errorCode: row.error_code,
    retryAllowed:
      row.state === 'failed' &&
      !row.mail_dispatched_at &&
      !['disable', 'logout-all'].includes(row.kind) &&
      row.error_code !== 'IDENTITY_ACCESS_CHANGED',
    mailDelivery: !['invite', 'password-reset'].includes(row.kind)
      ? 'not-requested'
      : row.state === 'succeeded'
        ? 'accepted'
        : row.mail_dispatched_at
          ? 'unconfirmed'
          : 'pending',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export async function registerIdentityAdministrationRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
  config: AppConfig,
  // Integration tests use the actual adapter with a pinned, disposable IdP transport.
  suppliedAdapter?: KeycloakAdminClient,
) {
  const settings = identityAdministrationConfig(config);
  const adapter = settings
    ? (suppliedAdapter ?? new KeycloakAdminClient(settings.settings))
    : undefined;
  const authorized = async (
    request: FastifyRequest,
    action: 'view' | 'create' | 'manage',
    userId: string,
  ) => authorization.isAllowed(request.user!, action, { kind: 'user', id: userId }, request.id);
  const hidden = (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send(errorEnvelope('NOT_FOUND', '대상을 찾을 수 없습니다.', request.id));
  const handle = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (!(error instanceof IdentityOperationError || error instanceof KeycloakAdminError))
      throw error;
    const unavailable = error.code.endsWith('UNAVAILABLE');
    const invalid = [
      'IDENTITY_OPERATION_INVALID',
      'IDENTITY_PROFILE_INVALID',
      'IDENTITY_NAME_ID_UNINITIALIZED',
    ].includes(error.code);
    const messages: Record<string, string> = {
      IDENTITY_ACCOUNT_CONFLICT:
        '확인한 Keycloak 계정 정보가 달라졌습니다. 계정을 다시 조회해 주세요.',
      IDENTITY_NAME_ID_UNINITIALIZED:
        '이 계정의 GCR 로그인 식별자가 아직 없습니다. 해당 계정으로 GCR 조직 로그인을 한 번 시도한 뒤 다시 조회해 주세요.',
      IDENTITY_OPERATION_CONFLICT:
        '다른 계정 작업이 진행 중이거나 요청 상태가 달라졌습니다. 목록을 새로 확인해 주세요.',
      IDENTITY_ADMIN_FORBIDDEN: 'Keycloak 서비스 계정에 사용자 관리 권한이 없습니다.',
      IDENTITY_ADMIN_CREDENTIAL_INVALID: 'Keycloak 서비스 계정 인증을 확인해 주세요.',
      IDENTITY_SECURITY_UNAVAILABLE: '보안 이벤트 수집 상태를 확인한 뒤 다시 요청해 주세요.',
      IDENTITY_LAST_ADMINISTRATOR_REQUIRED: '활성 관리자를 한 명 이상 유지해야 합니다.',
    };
    return reply
      .code(unavailable ? 503 : invalid ? 400 : error.code.endsWith('NOT_FOUND') ? 404 : 409)
      .send(
        errorEnvelope(
          error.code,
          messages[error.code] ??
            '계정 관리 작업을 처리하지 못했습니다. 작업 상태를 확인해 주세요.',
          request.id,
          unavailable,
        ),
      );
  };
  app.get(
    '/api/v1/admin/identity/capabilities',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await authorized(request, 'view', 'all'))) return hidden(request, reply);
      return {
        schemaVersion,
        enabled: Boolean(settings),
        authMode: config.AUTH_MODE,
        actions: settings
          ? [
              'create',
              'link',
              'invite',
              'password-reset',
              ...(config.IDENTITY_SECURITY_ENABLED ? ['disable', 'enable', 'logout-all'] : []),
            ]
          : [],
      };
    },
  );
  app.get(
    '/api/v1/admin/identity/operations',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!settings || !(await authorized(request, 'view', 'all'))) return hidden(request, reply);
      const rows = await database.query<IdentityOperation>(
        `select * from identity_admin_operations
      where idp_issuer=$1 and sp_entity_id=$2 order by created_at desc,id desc limit 100`,
        [settings.binding.issuer, settings.binding.entityId],
      );
      return { schemaVersion, items: rows.rows.map(identityOperationView) };
    },
  );
  app.post(
    '/api/v1/admin/identity/preview',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!settings || !adapter || !(await authorized(request, 'manage', 'all')))
        return hidden(request, reply);
      const input = previewBody.parse(request.body);
      try {
        const user = await adapter.getUser(input.keycloakUserId),
          identity = adapter.identity(user);
        if (!user.email) throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
        return {
          schemaVersion,
          keycloakUserId: user.id,
          username: user.username,
          email: user.email,
          displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username,
          enabled: user.enabled,
          nameId: identity.nameID,
        };
      } catch (error) {
        return handle(error, request, reply);
      }
    },
  );
  app.post(
    '/api/v1/admin/identity/operations',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!settings) return hidden(request, reply);
      const input = z
        .union([identityProvisioningRequest, identityLifecycleRequest])
        .parse(request.body);
      const lifecycle =
        input.kind === 'disable' || input.kind === 'enable' || input.kind === 'logout-all';
      if (lifecycle && !config.IDENTITY_SECURITY_ENABLED) return hidden(request, reply);
      const target = input.target.kind === 'new' ? 'new' : input.target.userId;
      if (!(await authorized(request, target === 'new' ? 'create' : 'manage', target)))
        return hidden(request, reply);
      try {
        const operation = lifecycle
          ? await requestIdentityLifecycle(database, settings.binding, request.user!.id, input)
          : await requestIdentityProvisioning(
              database,
              settings.binding,
              request.user!.id,
              identityProvisioningRequest.parse(input),
            );
        return reply.code(202).send({ schemaVersion, operation: identityOperationView(operation) });
      } catch (error) {
        return handle(error, request, reply);
      }
    },
  );
  app.post(
    '/api/v1/admin/identity/operations/:operationId/retry',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!settings) return hidden(request, reply);
      const { operationId } = operationParams.parse(request.params);
      z.object({}).strict().parse(request.body);
      const row = (
        await database.query<{ user_id: string | null; kind: IdentityOperation['kind'] }>(
          `select user_id,kind from identity_admin_operations
      where id=$1 and idp_issuer=$2 and sp_entity_id=$3`,
          [operationId, settings.binding.issuer, settings.binding.entityId],
        )
      ).rows[0];
      if (!row?.user_id || !(await authorized(request, 'manage', row.user_id)))
        return hidden(request, reply);
      if (
        ['enable', 'disable', 'logout-all'].includes(row.kind) &&
        !config.IDENTITY_SECURITY_ENABLED
      )
        return hidden(request, reply);
      try {
        if (row.kind === 'enable')
          await retryIdentityReactivation(
            database,
            settings.binding,
            request.user!.id,
            operationId,
          );
        else
          await retryIdentityOperation(database, settings.binding, request.user!.id, operationId);
        return reply.code(202).send({ schemaVersion, id: operationId });
      } catch (error) {
        return handle(error, request, reply);
      }
    },
  );
}
