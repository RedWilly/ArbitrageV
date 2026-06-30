import { RUNTIME } from '../constants';
import { type ReserveUpdate } from '../market/v2-types';
import { type V3PoolUpdate } from '../market/v3-types';

type UpdateHandler<TUpdate> = (updates: TUpdate[]) => Promise<void>;
type UpdateKey<TUpdate> = (update: TUpdate) => string;

export class LatestUpdateScheduler<TUpdate> {
  private isProcessing = false;
  private pendingUpdates: Map<string, TUpdate> = new Map();

  constructor(
    private readonly processBatch: UpdateHandler<TUpdate>,
    private readonly updateKey: UpdateKey<TUpdate>,
    private readonly label: string
  ) {}

  async submit(updates: TUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.merge(updates);

    if (this.isProcessing) {
      if (RUNTIME.debug) {
        console.log(`Merged ${updates.length} updates into ${this.pendingUpdates.size} pending ${this.label}`);
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

  private merge(updates: TUpdate[]): void {
    for (const update of updates) {
      this.pendingUpdates.set(this.updateKey(update), update);
    }
  }

  private drain(): TUpdate[] {
    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();
    return updates;
  }
}

export class ReserveUpdateScheduler extends LatestUpdateScheduler<ReserveUpdate> {
  constructor(processBatch: UpdateHandler<ReserveUpdate>) {
    super(processBatch, update => update.pairAddress.toLowerCase(), 'pairs');
  }
}

export class V3PoolUpdateScheduler extends LatestUpdateScheduler<V3PoolUpdate> {
  constructor(processBatch: UpdateHandler<V3PoolUpdate>) {
    super(processBatch, update => update.poolAddress.toLowerCase(), 'V3 pools');
  }
}
