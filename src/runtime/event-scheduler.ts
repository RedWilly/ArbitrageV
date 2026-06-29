import { RUNTIME } from '../constants';
import { type ReserveUpdate } from '../market/v2-types';

type ReserveUpdateHandler = (updates: ReserveUpdate[]) => Promise<void>;

export class ReserveUpdateScheduler {
  private isProcessing = false;
  private pendingUpdates: Map<string, ReserveUpdate> = new Map();

  constructor(private readonly processBatch: ReserveUpdateHandler) {}

  async submit(updates: ReserveUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.merge(updates);

    if (this.isProcessing) {
      if (RUNTIME.debug) {
        console.log(`Merged ${updates.length} updates into ${this.pendingUpdates.size} pending pairs`);
      }
      return;
    }

    this.isProcessing = true;

    try {
      while (this.pendingUpdates.size > 0) {
        await this.processBatch(this.drain());
      }
    } finally {
      this.isProcessing = false;
    }
  }

  clear(): void {
    this.pendingUpdates.clear();
  }

  private merge(updates: ReserveUpdate[]): void {
    for (const update of updates) {
      this.pendingUpdates.set(update.pairAddress.toLowerCase(), update);
    }
  }

  private drain(): ReserveUpdate[] {
    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();
    return updates;
  }
}
