import { resumeAnalysis } from '../services/analysis-resume.js';
import {
  analysisModelLimit,
  AnalysisModelCooldownError,
} from '../services/analysis-model-limit.js';
import { readTrustedCiEvidence } from '../services/trusted-ci.js';
import { sharedKnowledgeView } from '../services/analysis-shared-knowledge.js';
import { expandRelationships } from '@gcr/analysis-engine';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { formatReviewMarkdown, schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import { buildPermanentFileUrl } from '@gcr/github';
import {
  relationshipGraphSchema,
  reviewReportSchema,
  type EvidenceLocator,
  type RelationshipGraph,
  type ReviewFinding,
  type ReviewReport,
} from '@gcr/review-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { EventHub, formatServerSentEvent } from '../events/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository } from './worklist.js';

const analysisParams = z.object({ analysisId: z.string().uuid() });
const findingParams = analysisParams.extend({ findingId: z.string().uuid() });
const objectParams = analysisParams.extend({ objectId: z.string().uuid() });
const relationshipQuery = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  depth: z.coerce.number().int().min(1).max(5).default(1),
});
const exportQuery = z.object({ format: z.enum(['json', 'markdown']).default('json') });

type AnalysisContext = {
  analysisId: string;
  repositoryId: string;
  owner: string;
  name: string;
  webBaseUrl: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  snapshotId: string;
  pullNumber: number;
  pullTitle: string;
  elapsedMs: number | null;
  filePaths: Map<string, string>;
  previousFilePaths: Map<string, string>;
};

export async function registerAnalysisRoutes(
  app: FastifyInstance,
  database: Database,
  eventHub: EventHub,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  authorization: AuthorizationService,
) {
  app.post(
    '/api/v1/analyses/:analysisId/resume',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (
        !context ||
        !(await canReadRepository(
          database,
          authorization,
          request,
          context.repositoryId,
          'refresh',
        ))
      )
        return hiddenNotFound(request, reply);
      let result;
      try {
        result = await resumeAnalysis(database, analysisId, request.user!.id);
      } catch (error) {
        if (error instanceof AnalysisModelCooldownError)
          return reply.code(429).send({
            error: {
              code: error.message,
              message: `모델 계정 사용량 제한으로 ${error.retryAt} 이후 재개할 수 있습니다.`,
              retryable: true,
              retryAt: error.retryAt,
            },
          });
        if (error instanceof Error && error.message === 'REFRESH_LIMIT_EXCEEDED')
          return reply.code(429).send({
            error: {
              code: 'REFRESH_LIMIT_EXCEEDED',
              message: '진행 중인 분석이 너무 많습니다.',
              retryable: true,
            },
          });
        throw error;
      }
      if (!result)
        return reply.code(409).send({
          error: {
            code: 'ANALYSIS_RESUME_UNAVAILABLE',
            message:
              '현재 PR의 미완료 묶음 분석만 재개할 수 있습니다. 새 head는 다시 분석해 주세요.',
            retryable: false,
          },
        });
      return reply.code(202).send({
        schemaVersion,
        ...result,
        maxAdditionalModelCalls: config.ANALYSIS_GROUP_MAX_MODEL_CALLS,
      });
    },
  );
  app.get(
    '/api/v1/analyses/:analysisId/review-tasks',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      reply.header('cache-control', 'no-store');
      const plan = (
        await database.query(
          `select plan_hash,manifest from analysis_review_plans where analysis_id=$1`,
          [analysisId],
        )
      ).rows[0];
      const states = await database.query(
        `select state,error_code as "errorCode",count(*)::integer as count,min(retry_at) as "retryAt" from analysis_review_tasks where analysis_id=$1 group by state,error_code`,
        [analysisId],
      );
      return {
        schemaVersion,
        analysisId,
        planHash: plan?.plan_hash ?? null,
        filesTotal: plan?.manifest.files.length ?? 0,
        filesExcluded:
          plan?.manifest.files.filter(
            (file: { disposition: string }) => file.disposition === 'excluded',
          ).length ?? 0,
        tasks: states.rows,
        modelLimit: await analysisModelLimit(database, analysisId),
        maxAdditionalModelCalls: config.ANALYSIS_GROUP_MAX_MODEL_CALLS,
        canResume:
          Boolean(plan) &&
          (await canReadRepository(
            database,
            authorization,
            request,
            context.repositoryId,
            'refresh',
          )),
      };
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/ci-validation',
    { preHandler: requireUser },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { analysisId } = analysisParams.parse(request.params);
      if (!(await authorizedContext(database, authorization, request, analysisId)))
        return hiddenNotFound(request, reply);
      const evidence = await readTrustedCiEvidence(database, artifacts, config, analysisId);
      // Repository access can be revoked while the CI provider is responding.
      if (!(await authorizedContext(database, authorization, request, analysisId)))
        return hiddenNotFound(request, reply);
      return evidence;
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/status',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const result = await database.query(
        `select ar.id, ar.snapshot_id as "snapshotId", ar.revision, ar.state, ar.stage, ar.progress,
              ar.progress_detail as "progressDetail", ar.created_at as "createdAt", s.resolution,
              s.merge_base_sha as "mergeBaseSha", sr.base_sha as "baseSha", sr.head_sha as "headSha"
       from analysis_runs ar join snapshots s on s.id = ar.snapshot_id
       join snapshot_requests sr on sr.id = s.request_id where ar.id = $1`,
        [analysisId],
      );
      if (!result.rows[0]) return hiddenNotFound(request, reply);
      return {
        schemaVersion,
        repositoryId: context.repositoryId,
        pullNumber: context.pullNumber,
        analysis: result.rows[0],
      };
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/shared-knowledge',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      return sharedKnowledgeView(database, analysisId, context.repositoryId);
    },
  );
  app.get('/api/v1/analyses/:analysisId', { preHandler: requireUser }, async (request, reply) => {
    const { analysisId } = analysisParams.parse(request.params);
    const context = await authorizedContext(database, authorization, request, analysisId);
    if (!context) return hiddenNotFound(request, reply);
    const report = await readReport(database, artifacts, analysisId);
    if (!report) return artifactUnavailable(request, reply);
    return reportView(request, config, context, report);
  });

  app.get(
    '/api/v1/analyses/:analysisId/coverage',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      if (!(await authorizedContext(database, authorization, request, analysisId))) {
        return hiddenNotFound(request, reply);
      }
      const result = await database.query<{ coverage: ReviewReport['coverage'] }>(
        `select coverage from reports where analysis_run_id = $1`,
        [analysisId],
      );
      return result.rows[0]
        ? { schemaVersion, analysisId, ...result.rows[0].coverage }
        : artifactUnavailable(request, reply);
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/findings',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const report = await readReport(database, artifacts, analysisId);
      if (!report) return artifactUnavailable(request, reply);
      return {
        schemaVersion,
        analysisId,
        items: report.findings.map((finding) => findingView(request, config, context, finding)),
      };
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/findings/:findingId',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId, findingId } = findingParams.parse(request.params);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const report = await readReport(database, artifacts, analysisId);
      const finding = report?.findings.find((item) => item.id === findingId);
      return finding
        ? { schemaVersion, analysisId, ...findingView(request, config, context, finding) }
        : hiddenNotFound(request, reply);
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/objects',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      if (!(await authorizedContext(database, authorization, request, analysisId))) {
        return hiddenNotFound(request, reply);
      }
      const graph = await readGraph(database, artifacts, analysisId);
      return graph
        ? { schemaVersion, analysisId, items: graph.objects, coverage: graph.coverage }
        : artifactUnavailable(request, reply);
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/objects/:objectId/relationships',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId, objectId } = objectParams.parse(request.params);
      const query = relationshipQuery.parse(request.query);
      if (!(await authorizedContext(database, authorization, request, analysisId))) {
        return hiddenNotFound(request, reply);
      }
      const graph = await readGraph(database, artifacts, analysisId);
      if (!graph) return artifactUnavailable(request, reply);
      if (!graph.objects.some((object) => object.id === objectId)) {
        return hiddenNotFound(request, reply);
      }
      const direct = graph.relations.filter(
        (relation) => relation.sourceObjectId === objectId || relation.targetObjectId === objectId,
      );
      return {
        schemaVersion,
        analysisId,
        objectId,
        direction: query.direction,
        depth: query.depth,
        structure: {
          parents: direct.filter(
            (relation) => relation.kind === 'contains' && relation.targetObjectId === objectId,
          ),
          children: direct.filter(
            (relation) => relation.kind === 'contains' && relation.sourceObjectId === objectId,
          ),
        },
        dependencies: {
          uses: direct.filter(
            (relation) => relation.kind !== 'contains' && relation.sourceObjectId === objectId,
          ),
          usedBy: direct.filter(
            (relation) => relation.kind !== 'contains' && relation.targetObjectId === objectId,
          ),
        },
        objects: graph.objects,
        paths: expandRelationships(graph, objectId, query.direction, query.depth),
        coverage: graph.coverage,
      };
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/events',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      if (!(await authorizedContext(database, authorization, request, analysisId))) {
        return hiddenNotFound(request, reply);
      }
      const lastEventId = Number(request.headers['last-event-id'] ?? 0);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');
      const unsubscribe = await eventHub.subscribe(
        'analysis',
        analysisId,
        Number.isSafeInteger(lastEventId) ? lastEventId : 0,
        (event) => reply.raw.write(formatServerSentEvent(event)),
      );
      const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
      request.raw.once('close', () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/export',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const query = exportQuery.parse(request.query);
      const context = await authorizedContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const report = await readReport(database, artifacts, analysisId);
      if (!report) return artifactUnavailable(request, reply);
      const view = reportView(request, config, context, report);
      if (query.format === 'markdown') {
        return reply
          .header('content-disposition', `attachment; filename="review-${analysisId}.md"`)
          .type('text/markdown; charset=utf-8')
          .send(markdownReport(view, context.filePaths));
      }
      return reply
        .header('content-disposition', `attachment; filename="review-${analysisId}.json"`)
        .type('application/json')
        .send(view);
    },
  );
}

async function authorizedContext(
  database: Database,
  authorization: AuthorizationService,
  request: FastifyRequest,
  analysisId: string,
): Promise<AnalysisContext | null> {
  const result = await database.query<{
    analysis_id: string;
    repository_id: string;
    owner: string;
    name: string;
    web_base_url: string;
    head_sha: string;
    base_sha: string;
    merge_base_sha: string | null;
    snapshot_id: string;
    pull_number: number;
    pull_title: string;
    memory_owner_user_id: string | null;
    elapsed_ms: number | null;
  }>(
    `select ar.id as analysis_id, pr.repository_id, r.owner, r.name,
            i.web_base_url, sr.head_sha, sr.base_sha, s.merge_base_sha, s.id as snapshot_id,
            pr.number as pull_number, pr.title as pull_title, ar.memory_owner_user_id,
            (extract(epoch from(ar.finished_at-ar.started_at))*1000)::float8 as elapsed_ms
     from analysis_runs ar join snapshots s on s.id = ar.snapshot_id
     join snapshot_requests sr on sr.id = s.request_id
     join pull_requests pr on pr.id = sr.pull_request_id
     join repositories r on r.id = pr.repository_id
     join github_instances i on i.id = r.instance_id
     where ar.id = $1`,
    [analysisId],
  );
  const row = result.rows[0];
  if (
    !row ||
    (row.memory_owner_user_id &&
      row.memory_owner_user_id !== request.user!.id &&
      request.user!.role !== 'administrator') ||
    !(await canReadRepository(database, authorization, request, row.repository_id, 'view'))
  ) {
    return null;
  }
  const files = await database.query<{ id: string; path: string; previousPath: string | null }>(
    `select sf.id, sf.path, sf.previous_path as "previousPath" from snapshot_files sf
     join analysis_runs ar on ar.snapshot_id = sf.snapshot_id where ar.id = $1`,
    [analysisId],
  );
  return {
    analysisId: row.analysis_id,
    repositoryId: row.repository_id,
    owner: row.owner,
    name: row.name,
    webBaseUrl: row.web_base_url,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    mergeBaseSha: row.merge_base_sha ?? row.base_sha,
    snapshotId: row.snapshot_id,
    pullNumber: row.pull_number,
    pullTitle: row.pull_title,
    elapsedMs: row.elapsed_ms,
    filePaths: new Map(files.rows.map((file) => [file.id, file.path])),
    previousFilePaths: new Map(files.rows.map((file) => [file.id, file.previousPath ?? file.path])),
  };
}

async function readReport(
  database: Database,
  artifacts: FilesystemArtifactStore,
  analysisId: string,
): Promise<ReviewReport | null> {
  const locator = await artifactLocator(database, analysisId, 'report');
  if (!locator) return null;
  return reviewReportSchema.parse(await artifacts.readJson(locator));
}

async function readGraph(
  database: Database,
  artifacts: FilesystemArtifactStore,
  analysisId: string,
): Promise<RelationshipGraph | null> {
  const locator = await artifactLocator(database, analysisId, 'relationships');
  if (!locator) return null;
  return relationshipGraphSchema.parse(await artifacts.readJson(locator));
}

async function artifactLocator(database: Database, analysisId: string, type: string) {
  const result = await database.query<{ locator: string }>(
    `select locator from artifacts where scope_type = 'analysis'
     and scope_id = $1 and artifact_type = $2 and version = 1 and state = 'available'`,
    [analysisId, type],
  );
  return result.rows[0]?.locator ?? null;
}

function reportView(
  request: FastifyRequest,
  config: AppConfig,
  context: AnalysisContext,
  report: ReviewReport,
) {
  const origin = publicOrigin(request, config);
  return {
    ...report,
    // Older artifacts timed only the last recovered attempt. Keep those artifacts
    // immutable and use recorded run timestamps in the read projection.
    durationMs:
      context.elapsedMs === null ? report.durationMs : Math.max(0, Math.round(context.elapsedMs)),
    context: {
      repositoryId: context.repositoryId,
      owner: context.owner,
      name: context.name,
      pullNumber: context.pullNumber,
      pullTitle: context.pullTitle,
      snapshotId: context.snapshotId,
      baseSha: context.baseSha,
      headSha: context.headSha,
      mergeBaseSha: context.mergeBaseSha,
    },
    findings: report.findings.map((finding) => findingView(request, config, context, finding)),
    links: [
      {
        rel: 'self',
        href: `${origin}/reviews/${context.analysisId}`,
        target: 'same-tab',
        available: true,
      },
      {
        rel: 'json',
        href: `${origin}/api/v1/analyses/${context.analysisId}/export?format=json`,
        target: 'new-tab',
        available: true,
      },
      {
        rel: 'markdown',
        href: `${origin}/api/v1/analyses/${context.analysisId}/export?format=markdown`,
        target: 'new-tab',
        available: true,
      },
    ],
  };
}

function findingView(
  request: FastifyRequest,
  config: AppConfig,
  context: AnalysisContext,
  finding: ReviewFinding,
) {
  const origin = publicOrigin(request, config);
  const workspace = new URL(`/reviews/${context.analysisId}`, origin);
  workspace.searchParams.set('finding', finding.id);
  workspace.searchParams.set('file', finding.anchor.fileId);
  workspace.searchParams.set('side', finding.anchor.side);
  if (finding.anchor.startLine)
    workspace.searchParams.set('line', String(finding.anchor.startLine));
  return {
    ...finding,
    links: [
      { rel: 'finding', href: workspace.toString(), target: 'same-tab', available: true },
      evidenceLink(context, finding.anchor),
    ],
  };
}

function evidenceLink(context: AnalysisContext, locator: EvidenceLocator) {
  const path = (locator.side === 'mergeBase' ? context.previousFilePaths : context.filePaths).get(
    locator.fileId,
  );
  return path
    ? {
        rel: 'ghes',
        href: buildPermanentFileUrl(
          context.webBaseUrl,
          context.owner,
          context.name,
          locator.commitOid ??
            (locator.side === 'mergeBase' ? context.mergeBaseSha : context.headSha),
          path,
          locator.startLine,
          locator.endLine,
        ),
        target: 'new-tab',
        available: true,
      }
    : { rel: 'ghes', href: '', target: 'new-tab', available: false };
}

function publicOrigin(request: FastifyRequest, config: AppConfig): string {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${request.protocol}://${request.headers.host ?? 'localhost'}`;
}

function markdownReport(report: ReturnType<typeof reportView>, paths: Map<string, string>): string {
  return formatReviewMarkdown(
    report,
    [...paths].map(([id, path]) => ({ id, path })),
    {
      reportUrl: report.links.find((link) => link.rel === 'self')!.href,
    },
  );
}

function hiddenNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: '리소스를 찾을 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

function artifactUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'ARTIFACT_UNAVAILABLE',
      message: '분석 산출물을 읽을 수 없습니다.',
      requestId: request.id,
      retryable: true,
    },
  });
}
