// Deterministic scripted model for tests and offline development.
// Each task id maps to a queue of actions; unscripted tasks report done.
import type { LoopAction, ModelDescriptor, ModelProvider, ModelRequest, ModelResponse } from './types.js';

export class FakeModelProvider implements ModelProvider {
  id = 'fake';
  private scripts = new Map<string, LoopAction[]>();
  calls = 0;

  script(taskId: string, actions: LoopAction[]): void {
    this.scripts.set(taskId, [...actions]);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: 'fake-1', capabilities: ['tools'] }];
  }

  async decide(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    const queue = this.scripts.get(request.taskId);
    const action = queue?.shift() ?? { kind: 'done', summary: 'nothing scripted; done' };
    return { action };
  }
}
