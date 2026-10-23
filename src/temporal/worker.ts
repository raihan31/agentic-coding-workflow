import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { Logger } from '../log.js';
import type { ProjectStore } from '../store.js';
import { createActivities, type ActivityDeps } from './activities.js';
import { TASK_QUEUE } from './shared.js';

export const workflowsPath = fileURLToPath(new URL('./workflows.ts', import.meta.url));

/** Workflow code is bundled by webpack; map this project's ESM ".js" specifiers to the ".ts" sources. */
export const bundlerOptions = {
  webpackConfigHook: (config: { resolve?: Record<string, unknown> }) => {
    config.resolve = { ...config.resolve, extensionAlias: { '.js': ['.ts', '.js'] } };
    return config;
  },
};

export interface WorkerOptions { address: string; namespace: string; store: ProjectStore; logger: Logger; concurrency: number; deps?: ActivityDeps['deps']; }

/** Agent activities launch sandbox containers, so the worker runs where Docker is available (not in a container). */
export async function runWorker(opts: WorkerOptions): Promise<void> {
  const connection = await NativeConnection.connect({ address: opts.address });
  try {
    const worker = await Worker.create({
      connection, namespace: opts.namespace, taskQueue: TASK_QUEUE, workflowsPath, bundlerOptions: bundlerOptions as never,
      activities: createActivities({ store: opts.store, logger: opts.logger, deps: opts.deps }),
      maxConcurrentActivityTaskExecutions: opts.concurrency,
    });
    opts.logger.info({ address: opts.address, namespace: opts.namespace, task_queue: TASK_QUEUE, concurrency: opts.concurrency }, 'worker started');
    await worker.run();
  } finally {
    await connection.close();
  }
}
