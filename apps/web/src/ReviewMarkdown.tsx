import { memo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];
const components: Components = {
  // Report section 제목 아래에서 Markdown 자체의 heading 계층을 유지합니다.
  h1: ({ children }) => <h4>{children}</h4>,
  h2: ({ children }) => <h5>{children}</h5>,
  h3: ({ children }) => <h6>{children}</h6>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ children, href }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Model 응답에 포함된 외부 image가 자동으로 네트워크 요청을 만들지 않습니다.
  img: ({ alt }) => <span className="review-image-alt">{alt || '이미지 생략'}</span>,
  table: ({ children }) => (
    <div className="review-table-scroll" role="region" aria-label="검토 표" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export const ReviewMarkdown = memo(function ReviewMarkdown({ text }: { text: string }) {
  return (
    <div className="review-markdown">
      <Markdown
        remarkPlugins={plugins}
        components={components}
        skipHtml
        urlTransform={defaultUrlTransform}
      >
        {text}
      </Markdown>
    </div>
  );
});
