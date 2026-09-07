import { z } from 'zod';

// Browser와 Worker가 함께 사용하는 순수 데이터 contract. Node.js 의존성을 추가하지 않는다.

export const reviewSkillNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
export const reviewSkillSchema = z.object({
  name: reviewSkillNameSchema,
  title: z.string().trim().min(1).max(120),
  kind: z.enum(['perspective', 'form']),
  unit: z.enum(['code-segment', 'file', 'analysis']),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  instructions: z.string().trim().min(1).max(16_000),
  markdown: z.string().min(1).max(20_000),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReviewSkill = z.infer<typeof reviewSkillSchema>;

export const reviewSkillBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.array(reviewSkillSchema).min(4).max(32),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((bundle, context) => {
    const names = bundle.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: 'Skill name은 중복할 수 없습니다.' });
    }
    const required = {
      'unit-comment-block': 'code-segment',
      'overall-summary': 'file',
      'total-summary': 'analysis',
    };
    for (const [name, unit] of Object.entries(required)) {
      if (
        !bundle.skills.some(
          (skill) =>
            skill.name === name && skill.kind === 'form' && skill.unit === unit && skill.enabled,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: `${name} form Skill은 ${unit} 단위로 활성화해야 합니다.`,
        });
      }
    }
    if (!bundle.skills.some((skill) => skill.kind === 'perspective' && skill.enabled)) {
      context.addIssue({
        code: 'custom',
        message: '하나 이상의 perspective Skill을 활성화해야 합니다.',
      });
    }
    for (const skill of bundle.skills) {
      if (skill.kind === 'perspective' && skill.unit !== 'code-segment') {
        context.addIssue({
          code: 'custom',
          message: 'Perspective Skill의 분석 단위는 code-segment입니다.',
        });
      }
      if (skill.kind === 'form' && !Object.hasOwn(required, skill.name)) {
        context.addIssue({ code: 'custom', message: '지원하지 않는 form Skill입니다.' });
      }
    }
  });
export type ReviewSkillBundle = z.infer<typeof reviewSkillBundleSchema>;

export const analysisSkillSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  builtin: reviewSkillBundleSchema,
  effective: z.object({
    versionId: z.string().uuid().nullable(),
    version: z.number().int().positive().nullable(),
    source: z.enum(['builtin', 'administration']),
    bundle: reviewSkillBundleSchema,
  }),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      bundle: reviewSkillBundleSchema,
      contentHash: z.string(),
      active: z.boolean(),
      createdAt: z.string(),
      createdBy: z.string(),
      activatedAt: z.string().nullable(),
    }),
  ),
});
export type AnalysisSkillSettings = z.infer<typeof analysisSkillSettingsSchema>;

export const reviewAnalysisSchema = z
  .object({
    format: z.literal('commit-defender-total-summary-v1'),
    status: z.enum(['pass', 'blocked', 'incomplete', 'unavailable', 'failed', 'demo']),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable(),
    mode: z.enum(['ai-powered', 'hybrid', 'rule-based', 'fixture', 'disabled']),
    units: z.array(
      z.object({
        id: z.string().uuid(),
        kind: z.literal('unit-comment-block'),
        findingId: z.string().uuid(),
        segment: z.object({
          id: z.string().uuid(),
          fileId: z.string().uuid(),
          side: z.enum(['head', 'mergeBase']),
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        skill: z.object({
          name: reviewSkillNameSchema,
          version: z.number().int().positive(),
          contentHash: z.string(),
        }),
      }),
    ),
    files: z.array(
      z.object({
        fileId: z.string().uuid(),
        path: z.string(),
        status: z.enum(['reviewed', 'partial', 'not-reviewed']),
        summary: z.string(),
        priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullable(),
        unitIds: z.array(z.string().uuid()),
      }),
    ),
    skills: z.object({
      bundleHash: z.string(),
      versionId: z.string().uuid().nullable(),
      version: z.number().int().positive().nullable(),
      entries: z.array(reviewSkillSchema.omit({ markdown: true, instructions: true })),
    }),
    coverage: z.object({
      filesCompleted: z.number().int().nonnegative(),
      windowsPlanned: z.number().int().nonnegative(),
      windowsReviewed: z.number().int().nonnegative(),
      modelCalls: z.number().int().nonnegative(),
    }),
  })
  .superRefine((analysis, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    const unitIds = analysis.units.map((unit) => unit.id);
    const segmentIds = analysis.units.map((unit) => unit.segment.id);
    const findingIds = analysis.units.map((unit) => unit.findingId);
    if ([unitIds, segmentIds, findingIds].some((ids) => new Set(ids).size !== ids.length))
      fail('Unit, segment, finding은 일대일로 연결해야 합니다.');
    if (new Set(analysis.files.map((file) => file.fileId)).size !== analysis.files.length)
      fail('파일별 Overall Summary는 하나여야 합니다.');
    const listed = analysis.files.flatMap((file) => file.unitIds);
    if (
      listed.length !== unitIds.length ||
      new Set(listed).size !== listed.length ||
      listed.some((id) => !unitIds.includes(id))
    )
      fail('모든 unit은 하나의 Overall Summary에 포함되어야 합니다.');
    for (const unit of analysis.units) {
      const file = analysis.files.find((item) => item.fileId === unit.segment.fileId);
      if (!file?.unitIds.includes(unit.id)) fail('Unit과 Overall Summary의 파일이 다릅니다.');
      const { startLine, endLine } = unit.segment;
      if (
        (startLine === undefined) !== (endLine === undefined) ||
        (startLine !== undefined && endLine! < startLine)
      )
        fail('Code segment의 line 범위가 올바르지 않습니다.');
    }
    if (analysis.coverage.windowsReviewed > analysis.coverage.windowsPlanned)
      fail('검토한 window 수가 전체 window 수를 초과합니다.');
    if (
      analysis.coverage.filesCompleted !==
      analysis.files.filter((file) => file.status === 'reviewed').length
    )
      fail('검토 완료 파일 수가 일치하지 않습니다.');
  });
export type ReviewAnalysis = z.infer<typeof reviewAnalysisSchema>;
