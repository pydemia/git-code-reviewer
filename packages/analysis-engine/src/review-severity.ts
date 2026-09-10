import { reviewSeverityLevels, type ReviewSeverityLevel } from '@gcr/contracts';

export function severityInstructions(level: ReviewSeverityLevel, instructions = ''): string {
  const policy = reviewSeverityLevels[level];
  return [
    instructions,
    `## 분석 수준 (Severity Level): ${level}`,
    policy.description,
    `보고 범위: ${policy.scope}. 범위 밖의 priority는 comment로 생성하지 않는다.`,
    'P3는 Critical, P2는 Warning, P1은 Suggestion, P0는 Praise다. Level이 높아도 근거 없이 priority를 올리지 않는다.',
    '확인된 exploit·secret leak·치명적인 기능 중단·데이터 손실은 P3로 보고한다. Severity Level은 이런 문제를 생략하는 근거가 아니다.',
    'moderate에서는 중복을 합친 뒤 중요한 P1부터 파일당 최대 2개만 남긴다. P2/P3 개수는 제한하지 않는다.',
    'severe에서도 P0를 억지로 만들지 않으며, 같은 파일에 문제 지적이 있으면 Praise를 함께 넣지 않는다.',
    'Overall Summary와 Total Summary는 전달받은 comment와 coverage만 요약한다. 제외된 낮은 priority를 새로 추가하거나, 발견이 없다는 이유로 검토 범위 밖의 안전성을 보장하지 않는다.',
    '이 설정은 reasoning effort나 모델 호출 예산을 변경하지 않는다.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 중복 제거 뒤 호출한다. moderate의 P1 한도는 window가 아니라 파일 단위다. */
export function filterSeverityComments<T extends { file: string; priority: string }>(
  comments: T[],
  level: ReviewSeverityLevel,
): T[] {
  const minimum = reviewSeverityLevels[level].minRank;
  const suggestions = new Map<string, number>();
  return comments.filter((comment) => {
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3 }[comment.priority];
    if (rank === undefined || rank < minimum) return false;
    if (level !== 'moderate' || comment.priority !== 'P1') return true;
    const count = (suggestions.get(comment.file) ?? 0) + 1;
    suggestions.set(comment.file, count);
    return count <= 2;
  });
}
