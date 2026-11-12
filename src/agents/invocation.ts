import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// Runtime dependencies and work belong to one invocation, never a checkpoint.
export class AgentInvocation {
  #modelCalls = 0;
  #toolCalls = 0;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #modelRuns = new Map<string, () => void>();
  readonly #completion = Promise.withResolvers<void>();
  readonly signal = this.#controller.signal;
  readonly done = this.#completion.promise;
  readonly callbacks: BaseCallbackHandler;

  constructor(
    private readonly model: BaseChatModel,
    private readonly limits: { model: number; tool: number },
  ) {
    this.callbacks = BaseCallbackHandler.fromMethods({
      handleChatModelStart: (_model, _messages, runId) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.#modelRuns.set(runId, resolve);
        this.#pending.add(promise);
        void promise.then(() => this.#pending.delete(promise));
      },
      handleLLMEnd: (_output, runId) => this.#finishModel(runId),
      handleLLMError: (_error, runId) => this.#finishModel(runId),
    });
    // Lifecycle bookkeeping must not wait behind unrelated background callbacks.
    this.callbacks.awaitHandlers = true;
  }

  abort() {
    this.#controller.abort();
  }

  callModel<T>(work: (model: BaseChatModel) => T | Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (++this.#modelCalls > this.limits.model)
      throw new Error('Model call limit reached');
    return this.#track(() => work(this.model));
  }

  callTool<T>(work: () => T | Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (++this.#toolCalls > this.limits.tool)
      throw new Error('Tool call limit reached');
    return this.#track(work);
  }

  async run<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => this.abort(), timeoutMs);
    timer.unref();
    try {
      return await work();
    } catch (error) {
      this.abort();
      throw error;
    } finally {
      await this.waitForIdle();
      clearTimeout(timer);
      this.#completion.resolve();
    }
  }

  async waitForIdle(): Promise<void> {
    // SDK cancellation can finish a handler before the model's end/error callback.
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  async #track<T>(work: () => T | Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return work();
    });
    this.#pending.add(promise);
    try {
      return await promise;
    } finally {
      this.#pending.delete(promise);
    }
  }

  #finishModel(runId: string) {
    this.#modelRuns.get(runId)?.();
    this.#modelRuns.delete(runId);
  }
}
