import type { MouseEvent } from 'react';
import { expect, it, vi } from 'vitest';
import { navigateFromReviewBlock } from './review-block-navigation.ts';

function event(overrides: Record<string, unknown> = {}, interactive = false, selected = false) {
  return {
    button: 0,
    target: { closest: () => (interactive ? {} : null) },
    currentTarget: {
      ownerDocument: { defaultView: { getSelection: () => ({ isCollapsed: !selected }) } },
    },
    ...overrides,
  } as unknown as MouseEvent<HTMLElement>;
}

it('navigates once when the block body or spacing is clicked', () => {
  const navigate = vi.fn();
  navigateFromReviewBlock(event(), navigate);
  expect(navigate).toHaveBeenCalledTimes(1);
});

it('preserves internal controls, text selection and modified clicks', () => {
  const navigate = vi.fn();
  for (const click of [
    event({}, true),
    event({}, false, true),
    event({ button: 1 }),
    event({ defaultPrevented: true }),
    ...['ctrlKey', 'metaKey', 'shiftKey', 'altKey'].map((key) => event({ [key]: true })),
  ]) {
    navigateFromReviewBlock(click, navigate);
  }
  expect(navigate).not.toHaveBeenCalled();
});
