import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { approveSignal, guideSignal, pauseSignal, projectWorkflow, resumeSignal, viewQuery } from './workflows.js';
import { TASK_QUEUE, type ApproveInput, type GuideInput, type ProjectInput, type ProjectView } from './shared.js';

export const temporalAddress = () => process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const temporalNamespace = () => process.env.TEMPORAL_NAMESPACE ?? 'default';

export async function connectClient(): Promise<Client> {
  const connection = await Connection.connect({ address: temporalAddress() });
  return new Client({ connection, namespace: temporalNamespace() });
}

/** Workflow id = project id, so one durable workflow owns each project. */
export async function submitProject(client: Client, input: ProjectInput): Promise<string> {
  const handle = await client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: input.projectId, args: [input] });
  return handle.workflowId;
}

export const approveProject = (client: Client, id: string, approve: ApproveInput) => client.workflow.getHandle(id).signal(approveSignal, approve);
export const pauseProject = (client: Client, id: string) => client.workflow.getHandle(id).signal(pauseSignal);
export const resumeProject = (client: Client, id: string) => client.workflow.getHandle(id).signal(resumeSignal);
export const guideProjectTask = (client: Client, id: string, guide: GuideInput) => client.workflow.getHandle(id).signal(guideSignal, guide);
export const cancelProject = (client: Client, id: string) => client.workflow.getHandle(id).cancel();

/** Starts a new workflow run for a project whose previous run has ended. */
export async function resumeProjectRun(client: Client, dir: string, rate?: Pick<ProjectInput, 'rateLimitRetryMinutes' | 'rateLimitMaxWaitHours'>): Promise<void> {
  const { readProject } = await import('../project.js');
  const { state, config } = await readProject(dir);
  const { dirname } = await import('node:path');
  await client.workflow.start(projectWorkflow, {
    taskQueue: TASK_QUEUE, workflowId: state.id,
    args: [{ projectId: state.id, repo: state.repo, document: `${dir}/input/document.md`, runRoot: dirname(dir), config, resume: true, ...rate }],
  });
}

export async function projectView(client: Client, id: string): Promise<ProjectView | undefined> {
  try {
    return await client.workflow.getHandle(id).query(viewQuery);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return undefined;
    throw error;
  }
}
