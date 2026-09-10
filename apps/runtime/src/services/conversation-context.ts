import type { Database } from '@gcr/db';

export type ConversationEntry = { id: string; role: string; content: string; runId: string | null };

export function compactConversation(entries: ConversationEntry[]) {
  const recent = entries.slice(-8);
  const older = entries.slice(0, -8);
  const excerptLength = Math.max(16, Math.min(400, Math.floor(10000 / Math.max(1, older.length))));
  return {
    kind: 'untrusted_conversation_digest',
    method: 'extractive-v1',
    note: '발췌는 요약된 사실이나 승인된 메모리가 아닙니다. 사용자 판단·미해결 질문의 원문은 read_conversation으로 다시 읽고 과거 소스는 현재 revision에서 재확인하세요.',
    entries: older.map((entry) => ({
      messageId: entry.id,
      runId: entry.runId,
      role: entry.role,
      excerpt: entry.content.slice(0, excerptLength),
      omittedCharacters: Math.max(0, entry.content.length - excerptLength),
    })),
    recent: recent.map((entry) => ({
      messageId: entry.id,
      runId: entry.runId,
      role: entry.role,
      content: entry.content.slice(0, 2000),
      omittedCharacters: Math.max(0, entry.content.length - 2000),
    })),
  };
}

export async function readConversationContext(database: Database, sessionId: string) {
  const entries = await database.query<ConversationEntry>(
    `select m.id,m.role,m.content,r.id as "runId" from chat_messages m
     left join chat_runs r on r.assistant_message_id=m.id
     where m.session_id=$1 and m.status<>'pending' order by m.created_at,m.id`,
    [sessionId],
  );
  const questions = await database.query(
    `select q.id,q.run_id as "runId",left(q.question,200) as question,left(q.answer,400) as answer,
     length(q.question)>200 or length(q.answer)>400 as truncated from chat_questions q
     join chat_runs r on r.id=q.run_id where r.session_id=$1 order by q.expires_at desc limit 32`,
    [sessionId],
  );
  return { ...compactConversation(entries.rows), questions: questions.rows };
}

export function compactAgentMessages(messages: Record<string, unknown>[]) {
  if (Buffer.byteLength(JSON.stringify(messages)) <= 262144) return 0;
  let compacted = 0;
  for (const message of messages.slice(0, -4)) {
    if (
      message.type !== 'function_call_output' ||
      typeof message.output !== 'string' ||
      message.output.length < 2000
    )
      continue;
    let metadata: Record<string, unknown> = {};
    try {
      const result = JSON.parse(message.output) as Record<string, unknown>;
      metadata = Object.fromEntries(
        ['id', 'revision', 'sha', 'path', 'startLine', 'endLine', 'hash', 'blob']
          .filter((key) => key in result)
          .map((key) => [key, result[key]]),
      );
    } catch {
      metadata = {};
    }
    message.output = JSON.stringify({
      ...metadata,
      compacted: true,
      note: '본문은 입력 예산을 위해 제외했습니다. read_file 또는 read_conversation으로 필요한 범위를 다시 조회하세요.',
    });
    compacted++;
  }
  return compacted;
}
