import {
  createReviewSkillBundle,
  loadBuiltInReviewSkills,
  validateReviewSkillBundle,
} from '@gcr/analysis-engine';
import { errorEnvelope, schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator } from '../auth/index.js';
import { getEffectiveReviewSkills, listReviewSkillVersions } from '../services/analysis-skills.js';
import type { AuthorizationService } from '../services/authorization.js';

const bodySchema = z
  .object({ documents: z.array(z.string().min(1).max(20_000)).min(4).max(32) })
  .strict();
const paramsSchema = z.object({ versionId: z.string().uuid() });

export async function registerAnalysisSkillRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
) {
  const guard = async (request: FastifyRequest, action: 'view' | 'manage') =>
    authorization.isAllowed(
      request.user!,
      action,
      { kind: 'analysis_skill', id: 'global' },
      request.id,
    );
  app.get(
    '/api/v1/admin/analysis-skills',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await guard(request, 'view')))
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
      const [effective, items] = await Promise.all([
        getEffectiveReviewSkills(database),
        listReviewSkillVersions(database),
      ]);
      return { schemaVersion, builtin: loadBuiltInReviewSkills(), effective, items };
    },
  );

  app.post(
    '/api/v1/admin/analysis-skills/versions',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await guard(request, 'manage')))
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
      let bundle;
      try {
        bundle = createReviewSkillBundle(bodySchema.parse(request.body).documents);
      } catch {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'INVALID_REVIEW_SKILLS',
              'Skill frontmatter·분석 단위·중복 name과 필수 form을 확인하세요.',
              request.id,
            ),
          );
      }
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended('analysis-skills', 0))");
        await client.query('update analysis_skill_versions set active = false where active');
        const created = await client.query<{ id: string; version: number }>(
          `insert into analysis_skill_versions(version, bundle, content_hash, active, created_by, activated_by, activated_at)
         values ((select coalesce(max(version), 0) + 1 from analysis_skill_versions), $1::jsonb, $2, true, $3, $3, clock_timestamp())
         on conflict (content_hash) do update set active = true, activated_by = excluded.activated_by, activated_at = excluded.activated_at
         returning id, version`,
          [JSON.stringify(bundle), bundle.hash, request.user!.id],
        );
        const version = created.rows[0]!;
        await audit(client, request, 'analysis_skill.activate', version.id, bundle.hash);
        await client.query('commit');
        return reply.code(201).send({ schemaVersion, ...version, contentHash: bundle.hash });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    '/api/v1/admin/analysis-skills/versions/:versionId/activate',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await guard(request, 'manage')))
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
      const { versionId } = paramsSchema.parse(request.params);
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended('analysis-skills', 0))");
        const selected = await client.query<{ bundle: unknown }>(
          'select bundle from analysis_skill_versions where id = $1',
          [versionId],
        );
        if (!selected.rows[0]) {
          await client.query('rollback');
          return reply
            .code(404)
            .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
        }
        const bundle = validateReviewSkillBundle(selected.rows[0].bundle);
        await client.query('update analysis_skill_versions set active = false where active');
        await client.query(
          'update analysis_skill_versions set active = true, activated_by = $2, activated_at = clock_timestamp() where id = $1',
          [versionId, request.user!.id],
        );
        await audit(client, request, 'analysis_skill.activate', versionId, bundle.hash);
        await client.query('commit');
        return { schemaVersion, id: versionId };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    '/api/v1/admin/analysis-skills/reset',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await guard(request, 'manage')))
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtextextended('analysis-skills', 0))");
        await client.query('update analysis_skill_versions set active = false where active');
        await audit(
          client,
          request,
          'analysis_skill.reset',
          'global',
          loadBuiltInReviewSkills().hash,
        );
        await client.query('commit');
        return { schemaVersion, active: null };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );
}

async function audit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  id: string,
  hash: string,
) {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id, metadata)
    values ($1, $2, 'analysis_skill', $3, 'success', $4, $5::jsonb)`,
    [request.user!.subject, action, id, request.id, JSON.stringify({ contentHash: hash })],
  );
}
