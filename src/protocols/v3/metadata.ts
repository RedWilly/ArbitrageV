import { V3_POOLS } from './config';
import { type V3PoolConfig } from './types';

export function configuredV3PoolMetadata(): V3PoolConfig[] {
  return V3_POOLS.filter(pool => pool.enabled);
}
