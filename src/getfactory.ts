import { createPublicClient, http } from 'viem';
import { chiliz } from 'viem/chains';

const client = createPublicClient({
  chain: chiliz,
  transport: http(),
});

const ROUTER_ADDRESS = '0xbeedc90b22f26fd5847f6b15a2d4956aed802dba';
const ROUTER_ABI = [
  {
    "inputs": [],
    "name": "factory",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  }
];

async function getFactoryAddress() {
  try {
    const factoryAddress = await client.readContract({
      address: ROUTER_ADDRESS,
      abi: ROUTER_ABI,
      functionName: 'factory',
    });

    console.log('Factory Address:', factoryAddress);
  } catch (error) {
    console.error('Error fetching factory address:', error);
  }
}

getFactoryAddress();
