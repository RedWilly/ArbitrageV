import { type Address, type PublicClient } from 'viem';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { CARBON_CONTROLLERS } from './config';
import { CARBON_CONTROLLER_EVENT_ABI } from './events';
import { type CarbonStrategyStore } from './market';

export class CarbonEventAdapter implements ProtocolEventAdapter {
  readonly id = 'carbon';
  private readonly controllers = new Set(
    CARBON_CONTROLLERS.filter(controller => controller.enabled).map(controller => controller.address.toLowerCase())
  );

  constructor(private readonly store: CarbonStrategyStore) {}

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    const addresses = CARBON_CONTROLLERS
      .filter(controller => controller.enabled)
      .map(controller => controller.address);
    if (addresses.length === 0) return [];
    const unwatch = await client.watchContractEvent({
      address: addresses,
      abi: CARBON_CONTROLLER_EVENT_ABI,
      strict: true,
      onLogs,
      onError,
    });
    return [unwatch];
  }

  bufferKey(log: any): string | null {
    const key = log.address?.toLowerCase();
    return key && this.controllers.has(key) ? key : null;
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    if (logs.length > 0) await this.store.loadAll();
  }

  async apply(logs: any[]): Promise<void> {
    const byController = new Map<string, any[]>();
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      if (!key || !this.controllers.has(key)) continue;
      const group = byController.get(key);
      if (group) group.push(log);
      else byController.set(key, [log]);
    }
    for (const [controller, controllerLogs] of byController) {
      await this.store.handleEvents(controller as Address, controllerLogs);
    }
  }
}
