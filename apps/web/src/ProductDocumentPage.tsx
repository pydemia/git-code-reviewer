import { BookOpenText } from 'lucide-react';
import { useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { loadCurrentUser, type User } from './api.ts';
import { AppHeader } from './AppHeader.tsx';
import { DocumentationNav } from './DocumentationNav.tsx';
import { documentHeadingId, productDocuments } from './product-documents.ts';

const plugins = [remarkGfm];
const documentLinks: Record<string, string> = {
  'introduction.md': '/introduction',
  'features.md': '/features',
};
const components: Components = {
  h2: ({ children }) => <h2 id={documentHeadingId(String(children))}>{children}</h2>,
  a: ({ href, children }) => (
    <a href={href ? (documentLinks[href] ?? href) : undefined}>{children}</a>
  ),
  table: ({ children }) => (
    <div className="guide-table-wrap" role="region" aria-label="기능 안내 표" tabIndex={0}>
      <table className="guide-table">{children}</table>
    </div>
  ),
};

export function ProductDocumentPage({ documentId }: { documentId: keyof typeof productDocuments }) {
  const document = productDocuments[documentId];
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadCurrentUser(controller.signal).then(
      (currentUser) => setUser(currentUser),
      (error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      },
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    window.document.title = `${document.label} · Git Code Reviewer`;
    const heading = document.sections.find(
      ({ id }) =>
        window.location.hash === `#${id}` || window.location.hash === `#${encodeURIComponent(id)}`,
    );
    if (heading) window.document.getElementById(heading.id)?.scrollIntoView();
  }, [document]);

  return (
    <div className="guide-page">
      <AppHeader user={user} />
      <div className="guide-shell">
        <aside className="guide-nav" aria-label={`${document.label} 목차`}>
          <div className="guide-nav-title">
            <BookOpenText size={16} />
            <strong>문서</strong>
          </div>
          <DocumentationNav currentPath={document.path} />
          <p className="guide-nav-section-title">{document.label} 목차</p>
          {document.sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
        </aside>
        <main className="guide-main">
          <header className="guide-hero">
            <p className="eyebrow">{document.label}</p>
            <h1>{document.title}</h1>
          </header>
          <div className="product-document-body">
            <Markdown remarkPlugins={plugins} components={components} skipHtml>
              {document.body}
            </Markdown>
          </div>
          <footer className="guide-footer">
            <a href="/">Pull request 목록으로 돌아가기</a>
            <a href="/guide">설정과 사용 절차 보기</a>
          </footer>
        </main>
      </div>
    </div>
  );
}
