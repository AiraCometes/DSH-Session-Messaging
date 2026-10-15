import type { MessageSourceMap } from '@deepseek-ai/dsh-llm/types';

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'control-tower-github': {
      kind: 'control-tower-github';
      form: 'notice';
      summary: string;
    };
  }
}

export interface HarnessAdapterOptions {
  agents: { get(id: string): { id: string; steer(input: unknown): void } | undefined };
  createUserMessage(input: unknown): { id: string };
  bindings?: Map<string, string>;
}
export declare function createHarnessAdapter(options: HarnessAdapterOptions): import('../core/contracts.js').DeliveryAdapter;
