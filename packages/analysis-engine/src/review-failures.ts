// Provider 원문에는 source·credential이 포함될 수 있으므로 알려진 원인만 공개한다.
export function reviewFailure(error: unknown): { code: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : '';
  if (message === 'model_call_budget_exhausted')
    return { code: 'MODEL_CALL_BUDGET_EXHAUSTED', retryable: false };
  if (message === 'model_input_budget_exhausted')
    return { code: 'MODEL_INPUT_BUDGET_EXHAUSTED', retryable: false };
  if (message === 'model_capacity_wait') return { code: 'MODEL_CAPACITY_WAIT', retryable: true };
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return { code: 'MODEL_TIMEOUT', retryable: true };
  const providerCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (['missing_auth', 'invalid_auth', 'refresh_unavailable'].includes(providerCode))
    return { code: 'MODEL_AUTH_UNAVAILABLE', retryable: false };
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'ZodError') ||
    message === 'Invalid review result' ||
    providerCode === 'empty_response'
  )
    return { code: 'MODEL_OUTPUT_INVALID', retryable: true };
  return { code: 'MODEL_CALL_FAILED', retryable: true };
}

export function incompleteFileSummary(limitations: string[]): string {
  const reasons = new Set<string>();
  for (const limitation of limitations) {
    if (
      limitation.includes('MODEL_CALL_BUDGET_EXHAUSTED') ||
      limitation.includes('model call budget')
    )
      reasons.add(
        '분석의 모델 호출 예산을 모두 사용했습니다. 이미 사용한 요청은 Worker 재시작으로 초기화되지 않습니다.',
      );
    else if (
      limitation.includes('MODEL_INPUT_BUDGET_EXHAUSTED') ||
      limitation.includes('모델 입력 크기 제한')
    )
      reasons.add('모델에 전달할 입력이 허용 크기를 초과했습니다.');
    else if (limitation.includes('MODEL_CAPACITY_WAIT'))
      reasons.add('모델 계정의 동시 호출·rate limit 대기가 끝나지 않았습니다.');
    else if (limitation.includes('MODEL_TIMEOUT'))
      reasons.add('제한 시간 안에 모델 응답을 받지 못했습니다.');
    else if (limitation.includes('MODEL_OUTPUT_INVALID'))
      reasons.add('모델 응답이 비어 있거나 Review JSON 형식 검증에 실패했습니다.');
    else if (limitation.includes('MODEL_AUTH_UNAVAILABLE'))
      reasons.add('등록된 모델 계정의 인증 정보를 사용할 수 없습니다.');
    else if (limitation.includes('MODEL_CALL_FAILED'))
      reasons.add('모델 호출에 실패했습니다. 저장된 기록만으로 세부 원인을 구분할 수 없습니다.');
    else if (limitation.includes('분석 가능한 변경 line'))
      reasons.add('제공된 diff에 분석 가능한 변경 line이 없습니다.');
  }
  return [
    'AI review 미완료 — 이 파일의 검토 결과가 없습니다.',
    ...(reasons.size ? [...reasons] : ['사용 가능한 모델 검토 결과를 확보하지 못했습니다.']),
    '문제가 없다는 판정이 아닙니다. 분석 제한과 Provider 설정을 확인한 뒤 새 분석으로 다시 검토하세요.',
  ].join('\n\n');
}
