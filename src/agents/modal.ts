import { ModalSandbox } from '@langchain/modal';
import { ModalClient } from 'modal';
import { AppError } from '../runtime/app-error.js';
import { logError } from '../runtime/errors.js';

export async function createModalWorkspace(id: string, timeoutMs: number) {
  try {
    const volumeName = `agentloom-${id}`;
    const client = new ModalClient();
    try {
      await client.volumes.fromName(volumeName, { createIfMissing: true });
    } finally {
      client.close();
    }

    const backend = await ModalSandbox.create({
      appName: 'agentloom-sandbox',
      imageName: 'mcr.microsoft.com/playwright/mcp:v0.0.86',
      timeoutMs,
      workdir: '/workspace',
      volumes: { '/workspace': volumeName },
      env: { NODE_PATH: '/app/node_modules' },
    });
    let termination: Promise<void> | undefined;
    return {
      backend,
      close: () => (termination ??= closeWorkspace(backend)),
    };
  } catch (error) {
    logError('Modal sandbox setup failed', error);
    throw new AppError(503, 'Sandbox unavailable');
  }
}

async function closeWorkspace(backend: ModalSandbox) {
  try {
    // Wait for the sandbox to release the Volume before the next run.
    await backend.instance.terminate({ wait: true });
  } catch (error) {
    backend.instance.detach();
    logError('Modal sandbox termination failed', error);
  } finally {
    backend.client.close();
  }
}
