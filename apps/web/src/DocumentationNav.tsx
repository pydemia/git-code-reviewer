const documents = [
  { href: '/introduction', label: 'Introduction' },
  { href: '/features', label: '기능 목록' },
  { href: '/guide', label: '사용 가이드' },
];

export function DocumentationNav({ currentPath }: { currentPath: string }) {
  return (
    <nav className="documentation-menu" aria-label="문서 메뉴">
      {documents.map(({ href, label }) => (
        <a key={href} href={href} aria-current={currentPath === href ? 'page' : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
