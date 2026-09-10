import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  constrainWorkspaceLayout,
  migrateWorkspaceLayout,
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
    ).toBe(609);
    expect(
      resizeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, 'bottom', -40, desktopBounds).bottomHeight,
    ).toBe(320);
  });

  it('migrates old defaults once without discarding custom dimensions', () => {
    expect(migrateWorkspaceLayout('{"leftWidth":244,"chatWidth":316,"bottomHeight":176}')).toEqual(
      DEFAULT_WORKSPACE_LAYOUT,
    );
    const customized = { leftWidth: 310, chatWidth: 440, bottomHeight: 320 };
    expect(migrateWorkspaceLayout(JSON.stringify(customized))).toEqual(customized);
    expect(parseWorkspaceLayout('null')).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('reclaims the hidden sidebar width and preserves preferred dimensions after resize', () => {
    const bounds = { width: 1000, height: 800 };
    const visible = constrainWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, bounds);
    const hidden = constrainWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, bounds, true);
    expect(visible.leftWidth + visible.chatWidth + 360).toBeLessThanOrEqual(1000);
    expect(hidden.chatWidth).toBe(569);
    expect(hidden.leftWidth).toBe(244);
    expect(constrainWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, desktopBounds)).toEqual(
      DEFAULT_WORKSPACE_LAYOUT,
    );
    expect(resizeWorkspaceLayout(hidden, 'chat', -60, bounds, true).chatWidth).toBe(629);
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
