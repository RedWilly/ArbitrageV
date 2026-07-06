import { decodeEventLog, parseAbiItem, type Address } from 'viem';

export const V2_SYNC_EVENT_ABI = [
  parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
  parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)'),
];

const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

export function addressMap(addresses: readonly Address[]): Map<string, Address> {
  return new Map(addresses.map(address => [address.toLowerCase(), address]));
}

export function decodeV2SyncEvent(log: any): { reserve0: bigint; reserve1: bigint } | null {
  try {
    const topic = log.topics?.[0];
    if (topic === SYNC_TOPIC_UINT256) {
      const decoded = decodeEventLog({ abi: [V2_SYNC_EVENT_ABI[1]], data: log.data, topics: log.topics });
      return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
    }

    if (topic === SYNC_TOPIC_UINT112) {
      const decoded = decodeEventLog({ abi: [V2_SYNC_EVENT_ABI[0]], data: log.data, topics: log.topics });
      return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
    }
  } catch (error) {
    console.error('Failed to decode V2 Sync event:', error);
  }

  return null;
}
