import { type PublicClient } from 'viem';

export interface ProtocolEventAdapter {
  readonly id: string;
  watch(
    client: PublicClient,
    onLogs: (logs: any[]) => void | Promise<void>,
    onError: (error: any) => void | Promise<void>
  ): Promise<Array<() => void | Promise<void>>>;
  bufferKey(log: any): string | null;
  reconcile(logs: readonly any[]): Promise<void>;
  apply(logs: any[]): Promise<void>;
  clear?(): void;
}
