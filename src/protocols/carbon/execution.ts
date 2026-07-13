import { encodeAbiParameters, type Address } from 'viem';

type CarbonExecution = {
  rawFrom: Address;
  rawTo: Address;
  strategyIds: bigint[];
  amounts: bigint[];
};

export function encodeCarbonRouteData(execution: CarbonExecution): `0x${string}` {
  if (execution.strategyIds.length === 1) {
    return encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }],
      [execution.strategyIds[0], execution.rawFrom, execution.rawTo]
    );
  }
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint256[]' }, { type: 'uint128[]' }],
    [execution.rawFrom, execution.rawTo, execution.strategyIds, execution.amounts]
  );
}
