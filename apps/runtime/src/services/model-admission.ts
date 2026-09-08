import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Database } from '@gcr/db';

export type ModelBudget = { runKey: string; maxCalls: number; wait?: boolean };
const budgetContext = new AsyncLocalStorage<ModelBudget>();
export function withModelBudget<Result>(
  budget: ModelBudget,
  operation: () => Promise<Result>,
): Promise<Result> {
  return budgetContext.run(budget, operation);
}
export class ModelCapacityError extends Error {
  constructor(readonly resumeAfter: Date) {
    super('model_capacity_wait');
  }
}
export function admittedFetch(
  database: Pick<Database, 'query'>,
  quotaKey: string,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/oauth/token')) return fetcher(input, init);
    const inputBytes = Buffer.byteLength(String(init?.body ?? ''));
    if (inputBytes > 1048576) throw Error('model_input_budget_exhausted');
    const budget = budgetContext.getStore() ?? {
      runKey: `interactive:${randomUUID()}`,
      maxCalls: 8,
      wait: true,
    };
    const started = Date.now();
    let reservation: string | undefined;
    while (!reservation) {
      await database.query(
        'insert into model_account_capacity(quota_key) values ($1) on conflict do nothing',
        [quotaKey],
      );
      const result = await database.query<{ id: string }>(
        `with admission as (
        update model_account_capacity set reservation_id=gen_random_uuid(), lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp(),priority_run_key=null,priority_expires_at=null
        where quota_key=$1 and (lease_expires_at is null or lease_expires_at<clock_timestamp()) and (cooldown_until is null or cooldown_until<clock_timestamp())
          and (priority_expires_at is null or priority_expires_at<clock_timestamp() or priority_run_key=$2)
          and (select count(*) from model_request_ledger where run_key=$2) < $3
          and (select count(*) from model_request_ledger where quota_key=$1 and created_at>clock_timestamp()-interval '1 minute') < 60
          and (select coalesce(sum(input_bytes),0) from model_request_ledger where quota_key=$1 and created_at>clock_timestamp()-interval '1 minute') + $4 <= 1048576
        returning reservation_id
      ) insert into model_request_ledger(id,quota_key,run_key,state,input_bytes)
        select reservation_id,$1,$2,'reserved',$4 from admission returning id`,
        [quotaKey, budget.runKey, budget.maxCalls, Buffer.byteLength(String(init?.body ?? ''))],
      );
      reservation = result.rows[0]?.id;
      if (reservation) break;
      const count = await database.query<{ count: string }>(
        'select count(*)::text from model_request_ledger where run_key=$1',
        [budget.runKey],
      );
      if (Number(count.rows[0]?.count) >= budget.maxCalls)
        throw Error('model_call_budget_exhausted');
      if (!budget.wait)
        await database.query(
          "update model_account_capacity set priority_run_key=$2,priority_expires_at=clock_timestamp()+interval '15 seconds' where quota_key=$1 and (priority_expires_at is null or priority_expires_at<clock_timestamp() or priority_run_key=$2)",
          [quotaKey, budget.runKey],
        );
      const capacity = await database.query<{ until: Date }>(
        "select greatest(cooldown_until,clock_timestamp()+interval '3 seconds') as until from model_account_capacity where quota_key=$1",
        [quotaKey],
      );
      const until = capacity.rows[0]!.until;
      if (!budget.wait || Date.now() - started > 120000) throw new ModelCapacityError(until);
      init?.signal?.throwIfAborted();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000, Math.max(100, until.getTime() - Date.now()))),
      );
    }
    let finished = false;
    const controller = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const heartbeat = setInterval(() => {
      void database
        .query(
          "update model_account_capacity set lease_expires_at=clock_timestamp()+interval '180 seconds' where quota_key=$1 and reservation_id=$2 and lease_expires_at>clock_timestamp() returning quota_key",
          [quotaKey, reservation],
        )
        .then((result) => {
          if (!result.rowCount) controller.abort(Error('model_lease_lost'));
        })
        .catch(() => controller.abort(Error('model_lease_lost')));
    }, 15000);
    const finish = async (state: string, cooldown?: Date) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      await database.query(
        'update model_request_ledger set state=$2,finished_at=clock_timestamp() where id=$1',
        [reservation, state],
      );
      await database.query(
        'update model_account_capacity set reservation_id=null,lease_expires_at=null,cooldown_until=coalesce($3,cooldown_until) where quota_key=$1 and reservation_id=$2',
        [quotaKey, reservation, cooldown ?? null],
      );
    };
    try {
      init?.signal?.throwIfAborted();
      await database.query("update model_request_ledger set state='sent' where id=$1", [
        reservation,
      ]);
      const response = await fetcher(input, { ...init, signal });
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
        const parsed = raw ? Date.parse(raw) : NaN;
        const until = new Date(
          Math.min(
            Date.now() + 1800000,
            Math.max(
              Date.now() + 3000,
              seconds !== null
                ? Date.now() + seconds * 1000
                : Number.isFinite(parsed)
                  ? parsed
                  : Date.now() + 30000,
            ),
          ),
        );
        await response.body?.cancel();
        await finish('failed', until);
        throw new ModelCapacityError(until);
      }
      if (!response.ok || !response.body) {
        await finish(response.ok ? 'completed' : 'failed');
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              await finish('completed');
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            await finish('interrupted');
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          await finish('interrupted');
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      await finish('interrupted');
      throw error;
    }
  };
}
