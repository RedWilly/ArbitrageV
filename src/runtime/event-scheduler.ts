type UpdateHandler<TUpdate> = (updates: TUpdate[]) => Promise<void>;
type UpdateKey<TUpdate> = (update: TUpdate) => string;

export class LatestUpdateScheduler<TUpdate> {
  private isProcessing = false;
  private pendingUpdates: Map<string, TUpdate> = new Map();

  constructor(
    private readonly processBatch: UpdateHandler<TUpdate>,
    private readonly updateKey: UpdateKey<TUpdate>
  ) {}

  async submit(updates: TUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.merge(updates);

    if (this.isProcessing) {
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
