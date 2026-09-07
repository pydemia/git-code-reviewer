import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reviewSkillBundleSchema,
  reviewSkillSchema,
  type ReviewSkillBundle,
} from '@gcr/review-contract';

const headerKeys = new Set(['name', 'title', 'kind', 'unit', 'version', 'enabled']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 제한된 scalar frontmatter만 읽는다. YAML tag, include, command는 실행하지 않는다. */
export function parseReviewSkill(source: string) {
  const markdown = source.replace(/\r\n/g, '\n').trim() + '\n';
  if (Buffer.byteLength(markdown) > 24_000 || markdown.includes('\0'))
    throw new Error('Skill 파일 크기 또는 문자가 올바르지 않습니다.');
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(markdown);
  if (!match) throw new Error('Skill에는 frontmatter와 분석 지침이 필요합니다.');
  const metadata: Record<string, string | number | boolean> = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  for (const line of match[1]!.split('\n')) {
    const field = /^([a-z]+):\s*(.+)$/.exec(line);
    if (!field || !headerKeys.has(field[1]!) || field[1]! in metadata)
      throw new Error('Skill frontmatter의 key가 올바르지 않거나 중복되었습니다.');
    const [, name, value] = field;
    metadata[name!] =
      name === 'version'
        ? Number(value)
        : name === 'enabled'
          ? value === 'true'
            ? true
            : value === 'false'
              ? false
              : value!
          : value!;
  }
  return reviewSkillSchema.parse({
    ...metadata,
    instructions: match[2]!.trim(),
    markdown,
    contentHash: hash(markdown),
  });
}

export function createReviewSkillBundle(markdowns: string[]): ReviewSkillBundle {
  const skills = markdowns.map(parseReviewSkill).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return reviewSkillBundleSchema.parse({
    schemaVersion: 1,
    skills,
    hash: hash(JSON.stringify(skills.map((skill) => [skill.name, skill.contentHash]))),
  });
}

/** DB/job payload도 재파싱하여 hash와 metadata 변조를 검사한다. */
export function validateReviewSkillBundle(value: unknown): ReviewSkillBundle {
  const supplied = reviewSkillBundleSchema.parse(value);
  const canonical = createReviewSkillBundle(supplied.skills.map((skill) => skill.markdown));
  if (JSON.stringify(canonical) !== JSON.stringify(supplied))
    throw new Error('Skill bundle의 내용과 hash가 일치하지 않습니다.');
  return canonical;
}

export function loadBuiltInReviewSkills(
  directory = fileURLToPath(new URL('../skills/', import.meta.url)),
): ReviewSkillBundle {
  const documents: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'SKILL.md');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 24_000)
        throw new Error('Skill은 크기 제한 내의 일반 파일이어야 합니다.');
      const source = readFileSync(fd, 'utf8');
      if (parseReviewSkill(source).name !== entry.name)
        throw new Error('Skill directory와 name이 다릅니다.');
      documents.push(source);
    } finally {
      closeSync(fd);
    }
  }
  return createReviewSkillBundle(documents);
}

export function composeReviewSkills(
  bundle: ReviewSkillBundle,
  stage: 'unit-comment-block' | 'overall-summary' | 'total-summary',
): string {
  const validated = validateReviewSkillBundle(bundle);
  const skills = validated.skills.filter(
    (skill) =>
      skill.enabled &&
      (skill.name === stage || (stage === 'unit-comment-block' && skill.kind === 'perspective')),
  );
  return [
    '## Active Review Skills',
    ...skills.map(
      (skill) => `### ${skill.name} (v${skill.version}; ${skill.unit})\n${skill.instructions}`,
    ),
  ].join('\n\n');
}
