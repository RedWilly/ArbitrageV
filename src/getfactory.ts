import { createPublicClient, http } from 'viem';
import { shibarium } from 'viem/chains';

const client = createPublicClient({
  chain: shibarium,
  transport: http(),
});

const ROUTER_ADDRESS = '0x9b176...';
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
