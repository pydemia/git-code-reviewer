// Model/source 문자열에서는 이 제한된 서식만 복원한다. 임의 HTML·링크·mention은 허용하지 않는다.
export function formatReviewNarrative(value: string): string {
  const html = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('@', '＠');
  const literal = (text: string) => html(text).replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&');
  const code = (text: string) =>
    html(text).replace(/[\\`*_{}[\]()#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`);
  const inline = (text: string, allowBold = true): string =>
    text
      .split(allowBold ? /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__)/g : /(`[^`\n]+`)/g)
      .map((part) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2
          ? `<code>${code(part.slice(1, -1))}</code>`
          : allowBold &&
              ((part.startsWith('**') && part.endsWith('**')) ||
                (part.startsWith('__') && part.endsWith('__'))) &&
              part.length > 4
            ? `**${inline(part.slice(2, -2), false)}**`
            : literal(part),
      )
      .join('');
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
      // Report의 section(h2)·파일(h3)보다 낮은 heading으로만 표시한다.
      if (heading)
        return `${'#'.repeat(Math.min(6, heading[1]!.length + 3))} ${inline(heading[2]!)}`;
      const item = /^(\s*)([-+*]|\d{1,9}[.)])\s+(.+)$/.exec(line);
      if (item) {
        const indent = item[1]!.replaceAll('\t', '    ');
        const marker = /^\d/.test(item[2]!) ? `${Number.parseInt(item[2]!, 10)}.` : '-';
        return `${indent}${marker} ${inline(item[3]!)}`;
      }
      return inline(line);
    })
    .join('\n');
}
