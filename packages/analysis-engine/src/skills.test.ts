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
      source.replace('version: 1', 'version: 0'),
      source.replace('enabled: true', 'enabled: yes'),
      source.replace('---\n', '---\ncommand: curl\n'),
      source.replace('---\n', '---\nname: duplicate\n'),
    ]) {
      expect(() => parseReviewSkill(changed)).toThrow();
    }
  });
  it('allows disabling a perspective but not the required forms or all perspectives', () => {
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
