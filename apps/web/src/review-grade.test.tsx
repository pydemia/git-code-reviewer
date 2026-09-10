import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatReviewGrade, reportViewSchema, reviewGrades } from '@gcr/contracts';
import { ReviewGrade } from './ReviewGrade.tsx';
import { GuidePage } from './GuidePage.tsx';

describe('review quality grade presentation', () => {
  it.each([
    ['exceptional', '탁월', 'positive'],
    ['proficient', '우수', 'positive'],
    ['adequate', '양호', 'positive'],
    ['insufficient', '개선 필요', 'warning'],
    ['critical', '심각', 'danger'],
  ] as const)(
    'presents %s with a distinct Korean label and semantic tone',
    (grade, label, tone) => {
      expect(reviewGrades[grade].label).toBe(label);
      expect(reviewGrades[grade].tone).toBe(tone);
      expect(formatReviewGrade(grade)).toBe(`${label} (${grade})`);
      const html = renderToStaticMarkup(<ReviewGrade grade={grade} />);
      expect(html).toContain(`class="review-grade grade-${tone}"`);
      expect(html).toContain(`>${label}</span>`);
      expect(html).toContain(`aria-label="코드 품질: ${label} (${grade})"`);
      expect(html).toContain(reviewGrades[grade].description);
    },
  );

  it('covers every stored enum without renaming it and explains the distinction in the guide', () => {
    expect(Object.keys(reviewGrades)).toEqual(reportViewSchema.shape.grade.options);
    const guide = renderToStaticMarkup(<GuidePage />);
    for (const [grade, { description }] of Object.entries(reviewGrades)) {
      expect(guide).toContain(`<code>${grade}</code>`);
      expect(guide).toContain(description);
    }
    expect(guide).toContain('양호는 경고 등급이 아닙니다');
    expect(guide).toContain('merge 승인이나 결함이');
  });
});
