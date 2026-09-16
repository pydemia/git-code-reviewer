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

it('boxes explicit recommendation sections without including the next section or source link', () => {
  const source =
    '> **문제**\n>\n> 경계값을 확인합니다.\n>\n> **수정 제안**\n>\n> `limit`을 검증하세요.\n>\n> - 상한 검사\n> - 하한 검사\n>\n> [관련 코드 보기](https://github.example/code)\n\n## 수정제안\n\n```ts\nconst limit = 100;\n```\n\n## 영향\n\n호출부 영향';
  const html = renderToStaticMarkup(
    <ReviewMarkdown text={source} highlightRecommendations />,
  ).replace(/>\s+</g, '><');
  expect(html.match(/class="review-recommendation-box"/g)).toHaveLength(2);
  expect(html).toContain('<div class="review-recommendation-box"><p><strong>수정 제안</strong>');
  expect(html).toContain('</ul></div><p><a');
  expect(html).toContain('</pre></div><h5>영향</h5>');
  expect(renderToStaticMarkup(<ReviewMarkdown text={source} />)).not.toContain(
    'review-recommendation-box',
  );
});

it('keeps quoted code, ordinary prose and empty labels unchanged', () => {
  const html = renderToStaticMarkup(
    <ReviewMarkdown
      highlightRecommendations
      text={
        '수정 제안은 아직 없습니다.\n\n```md\n**수정 제안**\nexample\n```\n\n**수정 제안**\n\n**영향**\n\n미확인'
      }
    />,
  );
  expect(html).not.toContain('review-recommendation-box');
  expect(html).toContain('**수정 제안**');
});
