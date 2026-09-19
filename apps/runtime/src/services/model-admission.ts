import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Database } from '@gcr/db';
import { modelRateLimit } from './model-rate-limit.js';

export type ModelBudget = {
  runKey: string;
  maxCalls: number;
  wait?: boolean;
  concurrency?: number;
  lane?: 'batch' | 'interactive';
  durableGroup?: boolean;
  deadline?: number;
};
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
export class ModelUsageLimitError extends Error {
  constructor(readonly resumeAfter: Date) {
    super('model_usage_limit_reached');
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
      lane: 'interactive' as const,
    };
    const batch =
      budget.durableGroup ||
      (budget.lane ?? (budget.wait === true ? 'batch' : 'interactive')) === 'batch';
    // Oversized batch requests cannot fit the reserved half of the minute byte budget.
    // Fail explicitly instead of waiting forever for capacity that cannot exist.
    if (batch && inputBytes > 524288) throw Error('model_input_budget_exhausted');
    const started = Date.now();
    let reservation: string | undefined;
    while (!reservation) {
      if (budget.deadline && Date.now() >= budget.deadline)
        throw Error('model_time_budget_exhausted');
      init?.signal?.throwIfAborted();
      const result = await database.query<{ id: string }>(
        budget.durableGroup
          ? 'select reserve_group_model_request($1,$2,$3,$4,$5) as id'
          : 'select reserve_model_request($1,$2,$3,$4,$5,$6) as id',
        budget.durableGroup
          ? [quotaKey, budget.runKey, budget.maxCalls, inputBytes, budget.concurrency ?? 1]
          : [
              quotaKey,
              budget.runKey,
              budget.maxCalls,
              inputBytes,
              (budget.lane ?? (budget.wait === true ? 'batch' : 'interactive')) === 'batch',
              budget.concurrency ?? 1,
            ],
      );
      reservation = result.rows[0]?.id;
      if (reservation) break;
      const count = await database.query<{ count: string }>(
        'select count(*)::text from model_request_ledger where run_key=$1',
        [budget.runKey],
      );
      if (Number(count.rows[0]?.count) >= budget.maxCalls)
        throw Error('model_call_budget_exhausted');
      if (!budget.wait && budget.lane !== 'batch')
        await database.query(
          "update model_account_capacity set priority_run_key=$2,priority_expires_at=clock_timestamp()+interval '15 seconds' where quota_key=$1 and (priority_expires_at is null or priority_expires_at<clock_timestamp() or priority_run_key=$2)",
          [quotaKey, budget.runKey],
        );
      const capacity = await database.query<{ until: Date; usageLimited: boolean }>(
        `select greatest(cooldown_until,clock_timestamp()+interval '3 seconds') as until,
          cooldown_until>clock_timestamp() and exists(select 1 from model_request_ledger
            where quota_key=$1 and failure->>'providerCode'='usage_limit_reached'
              and (failure->>'retryAt')::timestamptz>clock_timestamp()) as "usageLimited"
          from model_account_capacity where quota_key=$1`,
        [quotaKey],
      );
      const until = capacity.rows[0]!.until;
      if (budget.durableGroup && capacity.rows[0]!.usageLimited)
        throw new ModelUsageLimitError(until);
      if (budget.deadline && until.getTime() >= budget.deadline)
        throw Error('model_time_budget_exhausted');
      if (
        !budget.wait ||
        Date.now() - started > 120000 ||
        (budget.durableGroup && until.getTime() - Date.now() > 5000)
      )
        throw new ModelCapacityError(until);
      init?.signal?.throwIfAborted();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000, Math.max(100, until.getTime() - Date.now()))),
      );
    }
    let finished = false;
    const controller = new AbortController();
    const signals = [
      controller.signal,
      ...(init?.signal ? [init.signal] : []),
      ...(budget.deadline ? [AbortSignal.timeout(Math.max(1, budget.deadline - Date.now()))] : []),
    ];
    const signal = AbortSignal.any(signals);
    const heartbeat = setInterval(() => {
      void database
        .query<{ renewed: boolean }>('select heartbeat_model_request($1) as renewed', [reservation])
        .then((result) => {
          if (!result.rows[0]?.renewed) controller.abort(Error('model_lease_lost'));
        })
        .catch(() => controller.abort(Error('model_lease_lost')));
    }, 15000);
    const finish = async (state: string, cooldown?: Date) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      await database.query(
        budget.durableGroup
          ? 'select finish_group_model_request($1,$2,$3)'
          : 'select finish_model_request($1,$2,$3)',
        [reservation, state, cooldown ?? null],
      );
    };
    try {
      init?.signal?.throwIfAborted();
      await database.query("update model_request_ledger set state='sent' where id=$1", [
        reservation,
      ]);
      const response = await fetcher(input, { ...init, signal });
      if (response.status === 429) {
        const recent = await database.query<{ state: string }>(
          "select state from model_request_ledger where quota_key=$1 and state in ('completed','failed','interrupted') order by created_at desc,id desc limit 5",
          [quotaKey],
        );
        const success = recent.rows.findIndex((row) => row.state === 'completed');
        const { retryAt: until, providerCode } = await modelRateLimit(
          response,
          success < 0 ? recent.rows.length : success,
        );
        await database.query('update model_request_ledger set failure=$2::jsonb where id=$1', [
          reservation,
          JSON.stringify({ httpStatus: 429, providerCode, retryAt: until.toISOString() }),
        ]);
        await finish('failed', until);
        if (budget.durableGroup && providerCode === 'usage_limit_reached')
          throw new ModelUsageLimitError(until);
        if (budget.deadline && until.getTime() >= budget.deadline)
          throw Error('model_time_budget_exhausted');
        throw new ModelCapacityError(until);
      }
      if (budget.durableGroup && [500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        const until = new Date(Date.now() + 15000 + Math.floor(Math.random() * 15000));
        await finish('failed', until);
        if (budget.deadline && until.getTime() >= budget.deadline)
          throw Error('model_time_budget_exhausted');
        throw new ModelCapacityError(until);
      }
      if (budget.durableGroup && [401, 403, 413].includes(response.status)) {
        await response.body?.cancel();
        await finish('failed');
        throw Error(
          response.status === 413 ? 'model_input_budget_exhausted' : 'model_auth_unavailable',
        );
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
