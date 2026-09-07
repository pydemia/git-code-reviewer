import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  constrainWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspaceLayout,
} from './workspace-layout.js';

const desktopBounds = { width: 1440, height: 800 };

describe('workspace layout', () => {
  it('restores valid persisted dimensions and tolerates invalid storage', () => {
    expect(parseWorkspaceLayout('{"leftWidth":300,"chatWidth":360,"bottomHeight":220}')).toEqual({
      leftWidth: 300,
      chatWidth: 360,
      bottomHeight: 220,
    });
    expect(parseWorkspaceLayout('not-json')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('resizes each panel from its visual divider direction', () => {
    expect(
      resizeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 'left', 40, desktopBounds).leftWidth,
    ).toBe(284);
    expect(
      resizeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 'chat', -40, desktopBounds).chatWidth,
    ).toBe(356);
    expect(
      resizeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 'bottom', -40, desktopBounds).bottomHeight,
    ).toBe(216);
  });

  it('preserves usable center and top panels at the workspace limits', () => {
    expect(
      constrainWorkspaceLayout(
        { leftWidth: 999, chatWidth: 999, bottomHeight: 999 },
        { width: 900, height: 500 },
      ),
    ).toEqual({ leftWidth: 180, chatWidth: 360, bottomHeight: 280 });
  });
});
