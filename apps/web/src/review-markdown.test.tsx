import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReviewMarkdown } from './ReviewMarkdown.tsx';

it('renders report headings, emphasis, nested lists, fenced code, tables and task lists', () => {
  const html = renderToStaticMarkup(
    <ReviewMarkdown
      text={
        '# 전체 Review Report\n\n**판정: PARTIAL**\n\n## 파일별 검토\n\n- `src/main.ts`\n  - **설정 검증** 필요\n\n1. 설정 확인\n2. 테스트 실행\n\n```ts\nconst safe = input < 5;\n```\n\n| 파일 | 상태 |\n| --- | --- |\n| main.ts | P2 |\n\n> 변경 영향 확인\n\n- [x] 검토 완료\n\n~~이전 내용~~'
      }
    />,
  );
  expect(html).toContain('<h4>전체 Review Report</h4>');
  expect(html).toContain('<h5>파일별 검토</h5>');
  expect(html).toContain('<strong>판정: PARTIAL</strong>');
  expect(html).toContain('<ol>');
  expect(html.match(/<ul>/g)).toHaveLength(2);
  expect(html).toContain('<code>src/main.ts</code>');
  expect(html).toContain('<pre><code class="language-ts">const safe = input &lt; 5;');
  expect(html).toContain('<table>');
  expect(html).toContain('<th>파일</th>');
  expect(html).toContain('<blockquote>');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('<del>이전 내용</del>');
});

it('does not execute HTML, unsafe URLs or fetch Markdown images', () => {
  const html = renderToStaticMarkup(
    <ReviewMarkdown
      text={
        '<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n[실행](javascript:alert%281%29)\n\n[확인](https://github.com/org-name/repo-name)\n\n![추적 이미지](https://tracker.example/private)\n\n`<script>`\n\n```html\n<img onerror="alert(1)">\n```'
      }
    />,
  );
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('tracker.example');
  expect(html).toContain('noopener noreferrer');
  expect(html).toContain('<code>&lt;script&gt;</code>');
  expect(html).toContain('&lt;img onerror=');
  expect(html).toContain('추적 이미지');
});
