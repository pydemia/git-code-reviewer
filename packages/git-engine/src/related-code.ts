import ts from 'typescript';

export type CodeCandidate = {
  path: string;
  line: number;
  content: string;
  relation: 'definition' | 'caller' | 'callee' | 'reference' | 'test';
  symbol: string;
  enclosing: string | null;
};

export function maskNonCode(source: string, python: boolean): string {
  return source.replace(
    python
      ? /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|#[^\n]*/g
      : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g,
    (value) => value.replace(/[^\n]/g, ' '),
  );
}

export function findCodeCandidates(
  filePath: string,
  lines: string[],
  query: string,
): CodeCandidate[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(query)) throw Error('symbol_identifier_required');
  if (!filePath.endsWith('.py')) return findSyntaxCandidates(filePath, lines, query);
  const python = filePath.endsWith('.py');
  const clean = maskNonCode(lines.join('\n'), python).split('\n');
  const matches: CodeCandidate[] = [];
  const escaped = query.replace(/\$/g, '\\$');
  const reference = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
  const call = new RegExp(`(?<![\\w$])${escaped}\\s*\\(`);
  const scopes: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  const test =
    /(?:^|\/)(?:tests?|__tests__)(?:\/|_)|(?:^|\/)test_|(?:[._](?:test|spec))\.[^.]+$|_test\.py$/.test(
      filePath,
    );
  for (const [index, line] of clean.entries()) {
    const indentation = line.search(/\S/);
    if (python && indentation >= 0)
      while (scopes.length && indentation <= scopes.at(-1)!.depth) scopes.pop();
    const declaration = python
      ? /\b(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)\s*[:(]/.exec(line)
      : /\bfunction\s+([\w$]+)\s*\(|\b(?:const|let)\s+([\w$]+)\s*=.*=>/.exec(line);
    const name = declaration?.[1] ?? declaration?.[2];
    const enclosing = scopes.at(-1)?.name ?? null;
    const add = (relation: CodeCandidate['relation'], symbol: string) =>
      matches.push({
        path: filePath,
        line: index + 1,
        content: lines[index]!.slice(0, 300),
        relation,
        symbol,
        enclosing,
      });
    if (name === query) add('definition', query);
    else if (reference.test(line))
      add(test ? 'test' : call.test(line) ? 'caller' : 'reference', query);
    if (enclosing === query)
      for (const found of line.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g))
        if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(found[1]!))
          add('callee', found[1]!);
    if (name) scopes.push({ name, depth: python ? indentation : depth });
    if (!python) {
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      while (scopes.length && depth <= scopes.at(-1)!.depth) scopes.pop();
    }
  }
  return matches;
}

function findSyntaxCandidates(filePath: string, lines: string[], query: string): CodeCandidate[] {
  const source = ts.createSourceFile(filePath, lines.join('\n'), ts.ScriptTarget.Latest, true);
  const matches: CodeCandidate[] = [];
  const test = /(?:^|\/)(?:tests?|__tests__)\/|[._](?:test|spec)\.[^.]+$/.test(filePath);
  const add = (
    node: ts.Node,
    relation: CodeCandidate['relation'],
    symbol: string,
    enclosing: string | null,
  ) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    matches.push({
      path: filePath,
      line: line + 1,
      content: lines[line]!.slice(0, 300),
      relation,
      symbol,
      enclosing,
    });
  };
  const visit = (node: ts.Node, enclosing: string | null) => {
    let scope = enclosing;
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name?.text === query
    )
      add(node, 'definition', query, enclosing);
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === query &&
      (!node.initializer ||
        (!ts.isArrowFunction(node.initializer) && !ts.isFunctionExpression(node.initializer)))
    )
      add(node, 'definition', query, enclosing);
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const name =
        'name' in node && node.name
          ? node.name.getText(source)
          : ts.isVariableDeclaration(node.parent)
            ? node.parent.name.getText(source)
            : null;
      if (name === query) add(node, 'definition', query, enclosing);
      scope = name;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = node.expression;
      const name = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : null;
      if (name === query) add(node, test ? 'test' : 'caller', query, scope);
      if (scope === query) add(node, 'callee', target.getText(source).slice(0, 160), scope);
    } else if (ts.isIdentifier(node) && node.text === query) {
      const parent = node.parent;
      const definition =
        (ts.isFunctionDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isVariableDeclaration(parent)) &&
        parent.name === node;
      const call =
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
      const property = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!definition && !call && !property) add(node, 'reference', query, scope);
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(source, null);
  return matches;
}
