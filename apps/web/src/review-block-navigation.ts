import type { MouseEvent } from 'react';

// 카드 본문·여백 클릭을 기존 코드 이동 action에 연결하되 내부 control과 복사를 보존합니다.
// Keyboard 사용자는 기존 제목/코드 이동 button으로 같은 action을 실행합니다.
export function navigateFromReviewBlock(event: MouseEvent<HTMLElement>, navigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const target = event.target as Element;
  if (
    target.closest(
      'a, button, input, select, textarea, summary, [role="button"], [tabindex], [contenteditable="true"]',
    )
  )
    return;
  const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
  if (selection && !selection.isCollapsed) return;
  navigate();
}
