import { type CarbonStrategyStore } from '../market/carbon';
import { createCarbonPlugin } from './carbon';
import { type ProtocolPlugin } from './protocol-plugin';
import { v2Plugin } from './v2';
import { v3Plugin } from './v3';

// Discovery order is intentional: Carbon limits itself to the V2/V3 token universe.
export function createProtocolPlugins(carbonStore?: CarbonStrategyStore): readonly ProtocolPlugin[] {
  return [v2Plugin, v3Plugin, createCarbonPlugin(carbonStore)];
}

export const PROTOCOL_PLUGINS = createProtocolPlugins();
