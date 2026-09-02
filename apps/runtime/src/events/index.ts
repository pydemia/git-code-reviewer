import type { Database, DatabaseClient } from '@gcr/db';

export type EventRow = {
  id: string;
  scope: string;
  scope_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
};

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function appendEvent(
  database: Queryable,
  scope: string,
  scopeId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const result = await database.query(
    `insert into event_log(scope, scope_id, type, payload)
     values ($1, $2, $3, $4::jsonb) returning id`,
    [scope, scopeId, type, JSON.stringify(payload)],
  );
  const id = (result.rows[0] as { id: string }).id;
  await database.query(`select pg_notify('gcr_events', $1)`, [id]);
  return id;
}

type Subscriber = {
  scope: string;
  scopeId: string;
  emit: (event: EventRow) => void;
};

export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private connection: DatabaseClient | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSeenId = 0;

  constructor(private readonly database: Database) {}

  async start(): Promise<void> {
    this.connection = await this.database.connect();
    const latest = await this.connection.query<{ id: string | null }>(
      'select max(id)::text as id from event_log',
    );
    this.lastSeenId = Number(latest.rows[0]?.id ?? 0);
    this.connection.on('notification', (message) => {
      const id = Number(message.payload);
      if (Number.isSafeInteger(id)) void this.dispatchById(id);
    });
    this.connection.on('error', () => undefined);
    await this.connection.query('listen gcr_events');
    this.pollTimer = setInterval(() => void this.tail(), 2_000);
  }

  async subscribe(
    scope: string,
    scopeId: string,
    afterId: number,
    emit: (event: EventRow) => void,
  ): Promise<() => void> {
    const replay = await this.database.query<EventRow>(
      `select id::text, scope, scope_id::text, type, payload, created_at
       from event_log where scope = $1 and scope_id = $2 and id > $3
       order by id limit 1000`,
      [scope, scopeId, afterId],
    );
    for (const event of replay.rows) emit(event);
    const subscriber = { scope, scopeId, emit };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.connection) {
      await this.connection.query('unlisten gcr_events').catch(() => undefined);
      this.connection.release();
    }
  }

  private async dispatchById(id: number): Promise<void> {
    if (id <= this.lastSeenId) return;
    const result = await this.database.query<EventRow>(
      `select id::text, scope, scope_id::text, type, payload, created_at
       from event_log where id = $1`,
      [id],
    );
    const event = result.rows[0];
    if (!event) return;
    this.lastSeenId = Math.max(this.lastSeenId, Number(event.id));
    for (const subscriber of this.subscribers) {
      if (subscriber.scope === event.scope && subscriber.scopeId === event.scope_id) {
        subscriber.emit(event);
      }
    }
  }

  private async tail(): Promise<void> {
    const result = await this.database.query<EventRow>(
      `select id::text, scope, scope_id::text, type, payload, created_at
       from event_log where id > $1 order by id limit 1000`,
      [this.lastSeenId],
    );
    for (const event of result.rows) await this.dispatchById(Number(event.id));
  }
}

export function formatServerSentEvent(event: EventRow): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({
    ...event.payload,
    occurredAt: event.created_at.toISOString(),
  })}\n\n`;
}
