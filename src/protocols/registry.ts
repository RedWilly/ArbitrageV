import { createCarbonPlugin } from './carbon';
import { type ProtocolPlugin } from './protocol-plugin';
import { v2Plugin } from './v2';
import { v3Plugin } from './v3';

// Discovery order is intentional: Carbon limits itself to the V2/V3 token universe.
export function createProtocolPlugins(): readonly ProtocolPlugin[] {
  return [v2Plugin, v3Plugin, createCarbonPlugin()];
}

export const PROTOCOL_PLUGINS = createProtocolPlugins();

const PLUGIN_BY_ID = new Map(PROTOCOL_PLUGINS.map(plugin => [plugin.id, plugin]));

export function protocolPlugin(id: ProtocolPlugin['id']): ProtocolPlugin {
  const plugin = PLUGIN_BY_ID.get(id);
  if (!plugin) throw new Error(`Protocol plugin is not registered: ${id}`);
  return plugin;
}
