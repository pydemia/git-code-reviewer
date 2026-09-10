import { describe, expect, it } from 'vitest';
import {
  composeReviewSkills,
  createReviewSkillBundle,
  loadBuiltInReviewSkills,
  parseReviewSkill,
  validateReviewSkillBundle,
} from './skills.js';

describe('review Skill catalog', () => {
  const defaults = loadBuiltInReviewSkills();
  it('loads six perspectives and three typed forms from actual packaged SKILL.md files', () => {
    expect(
      defaults.skills.filter((skill) => skill.kind === 'perspective').map((skill) => skill.name),
    ).toEqual([
      'correctness',
      'maintenance',
      'optimization',
      'review-history',
      'security',
      'setting',
    ]);
    expect(
      defaults.skills
        .filter((skill) => skill.kind === 'form')
        .map((skill) => [skill.name, skill.unit]),
    ).toEqual([
      ['overall-summary', 'file'],
      ['total-summary', 'analysis'],
      ['unit-comment-block', 'code-segment'],
    ]);
    expect(validateReviewSkillBundle(defaults)).toEqual(defaults);
  });
  it('keeps every translated checklist and Tone in the six version 2 perspectives', () => {
    for (const skill of defaults.skills.filter((skill) => skill.kind === 'perspective')) {
      expect(skill.version).toBe(2);
      const checklist = skill.instructions.split('## 점검 항목')[1]!.split('## 판단 어조')[0]!;
      expect(checklist.match(/^- \*\*/gm)).toHaveLength(skill.name === 'review-history' ? 6 : 8);
      expect(skill.instructions).toContain('## git-code-reviewer 적용 기준');
      expect(skill.instructions).toContain('Apache-2.0');
    }
  });
  it('uses version 3 summary forms with readable Markdown and no repeated full report', () => {
    const file = defaults.skills.find((skill) => skill.name === 'overall-summary')!;
    const total = defaults.skills.find((skill) => skill.name === 'total-summary')!;
    for (const skill of [file, total]) {
      expect(skill.version).toBe(3);
      expect(skill.instructions).toContain('Markdown bullet list');
      expect(skill.instructions).toContain('빈 줄');
      expect(skill.instructions).toContain('`file_comments`는 빈 배열');
      expect(skill.instructions).toContain('Header');
      expect(skill.instructions).toContain('개조식');
      expect(skill.instructions).toContain('문단');
    }
    expect(file.instructions).toContain('검토한 변경 범위에서 문제가 발견되지 않았습니다.');
    expect(total.instructions).toContain('report 전체를 다시 작성하지 않는다');
    expect(total.instructions).toContain('파일 순서대로 나열하지 않으며');
    expect(total.instructions).toContain('priority를 높이거나 낮추지 않는다');
    const comment = defaults.skills.find((skill) => skill.name === 'unit-comment-block')!;
    expect(comment.version).toBe(2);
    expect(comment.instructions).toContain('Header와 List');
    expect(comment.instructions).toContain('문단으로 설명');
  });
  it('allows a new perspective without an enum change and builds stage-specific prompts', () => {
    const source = defaults.skills
      .find((skill) => skill.name === 'correctness')!
      .markdown.replace('name: correctness', 'name: api-compatibility');
    const bundle = createReviewSkillBundle([
      ...defaults.skills.map((skill) => skill.markdown),
      source,
    ]);
    expect(composeReviewSkills(bundle, 'unit-comment-block')).toContain('### api-compatibility');
    expect(composeReviewSkills(bundle, 'unit-comment-block')).toContain('### security');
    expect(composeReviewSkills(bundle, 'overall-summary')).not.toContain('### security');
    expect(composeReviewSkills(bundle, 'overall-summary')).toContain('### overall-summary');
    expect(bundle.hash).not.toBe(defaults.hash);
  });
  it('hashes stable order and detects content or metadata tampering', () => {
    expect(
      createReviewSkillBundle(defaults.skills.map((skill) => skill.markdown).reverse()).hash,
    ).toBe(defaults.hash);
    const edited = structuredClone(defaults);
    edited.skills[0]!.instructions = 'changed';
    expect(() => validateReviewSkillBundle(edited)).toThrow('hash');
    const editedBody = defaults.skills.map((skill) => skill.markdown + '\n추가 확인 기준\n');
    expect(createReviewSkillBundle(editedBody).hash).not.toBe(defaults.hash);
  });
  it('rejects duplicate names, unsupported headers, traversal names and invalid version/flags', () => {
    const source = defaults.skills[0]!.markdown;
    expect(() =>
      createReviewSkillBundle([...defaults.skills.map((skill) => skill.markdown), source]),
    ).toThrow();
    for (const changed of [
      source.replace('name: correctness', 'name: ../secret'),
      source.replace(/version: \d+/, 'version: 0'),
      source.replace('enabled: true', 'enabled: yes'),
      source.replace('---\n', '---\ncommand: curl\n'),
      source.replace('---\n', '---\nname: duplicate\n'),
    ]) {
      expect(() => parseReviewSkill(changed)).toThrow();
    }
  });
  it('allows disabling a perspective but not the required forms or all perspectives', () => {
    const unsupported = defaults.skills
      .find((skill) => skill.name === 'unit-comment-block')!
      .markdown.replace('name: unit-comment-block', 'name: constructor');
    expect(() =>
      createReviewSkillBundle([...defaults.skills.map((skill) => skill.markdown), unsupported]),
    ).toThrow('지원하지 않는 form');
    const disabled = createReviewSkillBundle(
      defaults.skills.map((skill) =>
        skill.name === 'security'
          ? skill.markdown.replace('enabled: true', 'enabled: false')
          : skill.markdown,
      ),
    );
    expect(composeReviewSkills(disabled, 'unit-comment-block')).not.toContain('### security');
    expect(() =>
      createReviewSkillBundle(
        defaults.skills.map((skill) => skill.markdown.replace('enabled: true', 'enabled: false')),
      ),
    ).toThrow();
    expect(() =>
      createReviewSkillBundle(
        defaults.skills
          .filter((skill) => skill.name !== 'overall-summary')
          .map((skill) => skill.markdown),
      ),
    ).toThrow();
  });
  it('normalizes CRLF and treats body commands as text only', () => {
    const source = defaults.skills[0]!.markdown;
    expect(parseReviewSkill(source.replace(/\n/g, '\r\n')).contentHash).toBe(
      parseReviewSkill(source).contentHash,
    );
    expect(parseReviewSkill(source + '\n$(do-not-execute)\n').instructions).toContain(
      '$(do-not-execute)',
    );
    expect(() => parseReviewSkill(source + 'x'.repeat(25_000))).toThrow();
  });
});
