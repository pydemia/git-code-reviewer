const effortDescriptions: Record<string, string> = {
  low: 'low · 빠른 검토에 적합합니다. 복잡한 결함을 찾는 능력은 줄어들 수 있습니다.',
  medium: 'medium · 분석 속도와 복잡한 코드 검토 사이의 균형을 맞춥니다.',
  high: 'high · 복잡한 흐름과 경계 조건을 더 깊게 검토하며 시간이 더 걸릴 수 있습니다.',
  xhigh: 'xhigh · 깊은 추론에 더 많은 시간을 사용합니다. 충분한 분석 시간이 필요합니다.',
};
export function analysisEffortDescription(effort: string): string {
  return effortDescriptions[effort] ?? 'Model이 허용하는 effort를 선택하세요.';
}
