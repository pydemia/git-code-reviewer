import { formatReviewGrade, reviewGrades } from '@gcr/contracts';

export function ReviewGrade({ grade }: { grade: keyof typeof reviewGrades }) {
  const presentation = reviewGrades[grade];
  return (
    <span
      className={`review-grade grade-${presentation.tone}`}
      title={`${formatReviewGrade(grade)} — ${presentation.description}`}
      aria-label={`코드 품질: ${formatReviewGrade(grade)}`}
    >
      {presentation.label}
    </span>
  );
}
