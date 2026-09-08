import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { personalPromptUpdateSchema } from '@gcr/contracts';
import { PersonalPromptForm } from './PersonalPromptForm.tsx';

describe('personal Prompt form', () => {
  it('labels the scope, limits, clear/save controls and model disclosure', () => {
    const html = renderToStaticMarkup(<PersonalPromptForm initialPrompt="" />);
    expect(html).toContain('개인 Prompt');
    expect(html).toContain('본인의 Chat에만 적용');
    expect(html).toContain('선택한 모델로 전송');
    expect(html).toMatch(/maxlength="4000"/i);
    expect(html).toContain('aria-describedby="personal-prompt-help personal-prompt-count"');
    expect(html).toContain('개인 Prompt 저장');
    expect(html).toContain('내용 비우기');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it('renders saved text as text and never executes HTML', () => {
    const html = renderToStaticMarkup(
      <PersonalPromptForm initialPrompt="<script>alert(1)</script>" />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
  it('normalizes edges and preserves newlines with a strict owner-free API payload', () => {
    expect(personalPromptUpdateSchema.parse({ personalPrompt: '  설명\n예시  ' })).toEqual({
      personalPrompt: '설명\n예시',
    });
    expect(
      personalPromptUpdateSchema.safeParse({ personalPrompt: '내용', userId: 'other' }).success,
    ).toBe(false);
  });
});
