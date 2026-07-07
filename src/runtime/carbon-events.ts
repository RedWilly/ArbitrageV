import { parseAbiItem } from 'viem';

export const CARBON_CONTROLLER_EVENT_ABI = [
  parseAbiItem('event StrategyCreated(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)'),
  parseAbiItem('event StrategyDeleted(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)'),
  parseAbiItem('event StrategyUpdated(uint256 indexed id, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1, uint8 reason)'),
];
