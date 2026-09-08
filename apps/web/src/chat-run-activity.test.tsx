import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatRunView, SourceEvidence } from '@gcr/contracts';
import { ChatRunActivity, SourceEvidenceView } from './ChatRunActivity.tsx';

const source: SourceEvidence = {
  id: 'a'.repeat(24),
  revision: 'base',
  sha: 'b'.repeat(40),
  blob: 'c'.repeat(40),
  hash: 'd'.repeat(64),
  path: 'src/unchanged.ts',
  startLine: 12,
  endLine: 13,
  content: '<script>not executed</script>\nreturn 3;',
  truncated: true,
};
const run: ChatRunView = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  assistantMessageId: null,
  status: 'completed',
  phase: 'completed',
  content: '코드 확인 결과입니다.',
  error: null,
  modelCalls: 2,
  toolCalls: 1,
  contextBytes: 128,
  question: null,
  resumeAfter: null,
  evidence: [source],
  timeline: [{ id: '1', type: 'tool.completed', label: 'read_file' }],
};
function render(value: ChatRunView) {
  return renderToStaticMarkup(
    <ChatRunActivity
      run={value}
      error=""
      sending={false}
      onAnswer={async () => {}}
      onCancel={async () => {}}
      onEvidence={() => {}}
    />,
  );
}
describe('interactive review states', () => {
  it.each([
    ['queued', '분석 대기'],
    ['running', '분석 중'],
    ['awaiting_input', '응답을 기다리고 있습니다'],
    ['waiting_capacity', '계정 호출 한도 대기'],
    ['completed', '분석 완료'],
    ['partial', '부분 완료'],
    ['failed', '분석 실패'],
    ['cancelled', '중단됨'],
  ] as const)('renders %s distinctly', (status, label) => {
    expect(render({ ...run, status })).toContain(label);
  });
  it('shows persisted question choices and free text instead of a pending spinner', () => {
    const html = render({
      ...run,
      status: 'awaiting_input',
      question: {
        id: run.id,
        question: '재시도를 허용하나요?',
        options: ['허용', '금지'],
        answer: null,
        expiresAt: new Date().toISOString(),
      },
    });
    expect(html).toContain('재시도를 허용하나요?');
    expect(html).toContain('<textarea');
    expect(html).toContain('답변하고 분석 계속');
  });
  it('keeps source identity and escapes repository HTML', () => {
    expect(render(run)).toContain('src/unchanged.ts:12');
    const html = renderToStaticMarkup(<SourceEvidenceView source={source} onClose={() => {}} />);
    expect(html).toContain(source.sha);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('파일 전체를 검토했다는 뜻은 아닙니다.');
  });
});
