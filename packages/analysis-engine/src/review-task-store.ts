import type { LegacyAnalysisReport } from '@gcr/review-contract';
import type { ImpactPlan, ImpactTask } from './impact-plan.js';

export type TaskResult = { report: LegacyAnalysisReport; truncated: boolean };
export type TaskFailure = {
  state: 'retry-wait' | 'budget-wait' | 'failed' | 'blocked';
  code: string;
  retryAt?: Date;
};
export interface ReviewTaskStore {
  initialize(plan: ImpactPlan): Promise<Map<string, TaskResult>>;
  start(task: ImpactTask): Promise<void>;
  complete(task: ImpactTask, result: TaskResult): Promise<void>;
  fail(task: ImpactTask, failure: TaskFailure): Promise<void>;
}
