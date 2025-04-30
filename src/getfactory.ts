import { createPublicClient, http } from 'viem';
import { dogechain } from 'viem/chains';

const client = createPublicClient({
  chain: dogechain,
  transport: http(),
});

const ROUTER_ADDRESS = '0x3fC0A08974D7f6a22a0f8D63eD60B4D935b53F5A';
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
