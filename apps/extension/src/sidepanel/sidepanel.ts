// Side panel: thin client over the internal CabotRuntime API (spec §18-19).
// It renders task/agent state and forwards user intent; it contains no agent
// logic, no tool dispatch, no model calls.
export interface SidePanelDeps {
  sendToRuntime: (msg: unknown) => Promise<unknown>;
}

export function createSidePanel(deps: SidePanelDeps) {
  async function refreshTasks(): Promise<unknown> {
    return deps.sendToRuntime({ type: 'cabot.list-tasks' });
  }
  async function pauseTask(taskId: string): Promise<unknown> {
    return deps.sendToRuntime({ type: 'cabot.pause-task', taskId });
  }
  async function resumeTask(taskId: string): Promise<unknown> {
    return deps.sendToRuntime({ type: 'cabot.resume-task', taskId });
  }
  return { refreshTasks, pauseTask, resumeTask };
}
