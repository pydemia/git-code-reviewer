export type WorkspaceLayout = {
  leftWidth: number;
  chatWidth: number;
  bottomHeight: number;
};

export type WorkspaceResizeHandle = 'left' | 'chat' | 'bottom';

export type WorkspaceBounds = {
  width: number;
  height: number;
};

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  leftWidth: 244,
  chatWidth: 316,
  bottomHeight: 176,
};

export const WORKSPACE_LAYOUT_LIMITS = {
  leftMin: 180,
  leftMax: 420,
  chatMin: 240,
  chatMax: 480,
  mainMin: 360,
  bottomMin: 120,
  topMin: 220,
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.round(value), minimum), Math.max(minimum, maximum));
}

export function parseWorkspaceLayout(value: string | null): WorkspaceLayout {
  if (!value) return DEFAULT_WORKSPACE_LAYOUT;
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceLayout>;
    return {
      leftWidth: Number.isFinite(parsed.leftWidth)
        ? Number(parsed.leftWidth)
        : DEFAULT_WORKSPACE_LAYOUT.leftWidth,
      chatWidth: Number.isFinite(parsed.chatWidth)
        ? Number(parsed.chatWidth)
        : DEFAULT_WORKSPACE_LAYOUT.chatWidth,
      bottomHeight: Number.isFinite(parsed.bottomHeight)
        ? Number(parsed.bottomHeight)
        : DEFAULT_WORKSPACE_LAYOUT.bottomHeight,
    };
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}

export function constrainWorkspaceLayout(
  layout: WorkspaceLayout,
  bounds: WorkspaceBounds,
): WorkspaceLayout {
  const leftWidth = clamp(
    layout.leftWidth,
    WORKSPACE_LAYOUT_LIMITS.leftMin,
    Math.min(
      WORKSPACE_LAYOUT_LIMITS.leftMax,
      bounds.width - layout.chatWidth - WORKSPACE_LAYOUT_LIMITS.mainMin,
    ),
  );
  const chatWidth = clamp(
    layout.chatWidth,
    WORKSPACE_LAYOUT_LIMITS.chatMin,
    Math.min(
      WORKSPACE_LAYOUT_LIMITS.chatMax,
      bounds.width - leftWidth - WORKSPACE_LAYOUT_LIMITS.mainMin,
    ),
  );
  const bottomHeight = clamp(
    layout.bottomHeight,
    WORKSPACE_LAYOUT_LIMITS.bottomMin,
    bounds.height - WORKSPACE_LAYOUT_LIMITS.topMin,
  );

  return { leftWidth, chatWidth, bottomHeight };
}

export function resizeWorkspaceLayout(
  layout: WorkspaceLayout,
  handle: WorkspaceResizeHandle,
  delta: number,
  bounds: WorkspaceBounds,
): WorkspaceLayout {
  const resized = { ...layout };
  if (handle === 'left') resized.leftWidth += delta;
  if (handle === 'chat') resized.chatWidth -= delta;
  if (handle === 'bottom') resized.bottomHeight -= delta;
  return constrainWorkspaceLayout(resized, bounds);
}
