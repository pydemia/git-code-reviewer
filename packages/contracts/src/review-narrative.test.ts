import { describe, expect, it } from 'vitest';
import { formatReviewNarrative } from './review-narrative.js';

describe('safe review narrative formatting', () => {
  it('keeps paragraphs, normalized lists, short headings and nested inline code in emphasis', () => {
    expect(
      formatReviewNarrative(
        '# 결론\r\n\r\n- **`check()` 확인**\r\n  * __예외 처리__\r\n\r\n1) 검증\r\n2. 적용',
      ),
    ).toBe(
      '#### 결론\n\n- **<code>check&#40;&#41;</code> 확인**\n  - **예외 처리**\n\n1. 검증\n2. 적용',
    );
  });
  it('does not enable HTML, links, mention, HTML entities or disclosure injection', () => {
    const output = formatReviewNarrative(
      '- **</details><script>@all</script>**\n[run](javascript:alert(1))\n`<img src=x>` &lt;script&gt;',
    );
    expect(output).toContain('- **&lt;/details&gt;&lt;script&gt;＠all&lt;/script&gt;**');
    expect(output).toContain('\\[run\\]\\(javascript:alert\\(1\\)\\)');
    expect(output).toContain('<code>&lt;img src=x&gt;</code>');
    expect(output).toContain('&amp;lt;script&amp;gt;');
    for (const unsafe of ['<script>', '<img', '</details>', '@all', '[run](javascript:'])
      expect(output).not.toContain(unsafe);
  });
  it('keeps unmatched formatting punctuation literal', () => {
    expect(formatReviewNarrative('**미완성 *표시* `code')).toBe('\\*\\*미완성 \\*표시\\* \\`code');
  });
  it('keeps generated headings below report sections and escapes heading content', () => {
    expect(formatReviewNarrative('# A\n## B\n### C\n###### D')).toBe(
      '#### A\n##### B\n###### C\n###### D',
    );
    expect(formatReviewNarrative('## <script>@all</script>')).toBe(
      '##### &lt;script&gt;＠all&lt;/script&gt;',
    );
  });
});
