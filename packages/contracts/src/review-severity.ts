import { z } from 'zod';

export const reviewSeverityLevelSchema = z.enum([
  'lean',
  'generous',
  'moderate',
  'rigorous',
  'severe',
]);
export type ReviewSeverityLevel = z.infer<typeof reviewSeverityLevelSchema>;
export const defaultReviewSeverityLevel: ReviewSeverityLevel = 'moderate';

// Commit Defender의 실제 Prompt/filter 기준. Level은 reasoning effort와 별개다.
export const reviewSeverityLevels = {
  lean: {
    description: '기능 중단·보안 취약점·데이터 손실 등 치명적인 문제만 보고합니다.',
    scope: 'P3 Critical',
    minRank: 3,
  },
  generous: {
    description: '실제 위험이 분명한 오류와 중요한 경고를 중심으로 검토합니다.',
    scope: 'P2 Warning · P3 Critical',
    minRank: 2,
  },
  moderate: {
    description: '의미 있는 문제와 개선점을 균형 있게 검토하며, 제안은 파일당 2개로 제한합니다.',
    scope: 'P1 Suggestion 최대 2개/파일 · P2 · P3',
    minRank: 1,
  },
  rigorous: {
    description: '작은 개선점과 best practice 위반까지 폭넓게 검토합니다.',
    scope: 'P1 Suggestion · P2 · P3',
    minRank: 1,
  },
  severe: {
    description: '근거 있는 모든 개선점을 엄격히 검토하고, 잘된 변경에 대한 의견도 허용합니다.',
    scope: 'P0 Praise · P1 · P2 · P3',
    minRank: 0,
  },
} as const;
