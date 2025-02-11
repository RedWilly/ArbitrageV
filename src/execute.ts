import { type Address, createPublicClient, http, parseAbiItem, formatUnits } from 'viem';
import { ArbitrageGraph } from './graph';
import { ARB_CONTRACT, DEBUG } from './constants';
import ArbABI from './ABI/Arb.json';
import { type NetworkConfig } from './network';

interface ArbitrageOpportunity {
    path: Address[];
    pairs: Address[];
    fees: number[];
    optimalAmount: bigint;
    expectedProfit: bigint;
}

// Keeps track of executed pairs to avoid conflicts
class OpportunityManager {
    private networkConfig: NetworkConfig;

    constructor(networkConfig: NetworkConfig) {
        this.networkConfig = networkConfig;
    }

    // Process and execute a batch of opportunities
    async processOpportunities(
        graph: ArbitrageGraph,
        opportunities: ArbitrageOpportunity[]
    ): Promise<void> {
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => 
            Number(b.expectedProfit - a.expectedProfit)
        );

        if (DEBUG) {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        }

        for (const opp of sortedOpps) {
            try {
                // Execute the opportunity
                await this.executeArbitrageOpportunity(graph, opp);
                
                if (DEBUG) {
                    console.log('Successfully executed opportunity:', {
                        profit: formatUnits(opp.expectedProfit, 18),
                        pairs: opp.pairs
                    });
                }
            } catch (error) {
                if (DEBUG) {
                    console.error('Failed to execute opportunity:', error);
                }
            }
        }
    }

    private async executeArbitrageOpportunity(
        graph: ArbitrageGraph,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        const startToken = opportunity.path[0];
        const endToken = opportunity.path[opportunity.path.length - 1];
        const isCircular = startToken.toLowerCase() === endToken.toLowerCase();

        if (isCircular) {
            await this.executeWithFlashswap(graph, opportunity);
        } else {
            await this.executeDirectly(opportunity);
        }
    }

    private async executeWithFlashswap(
        graph: ArbitrageGraph,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (!ARB_CONTRACT || !ARB_CONTRACT.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid ARB_CONTRACT address');
        }

        const startToken = opportunity.path[0];

        // Find the best pair for flashswap
        const flashLoanPair = graph.findBestPairForToken(
            startToken,
            opportunity.optimalAmount,
            opportunity.pairs
        );

        if (!flashLoanPair) {
            throw new Error(`No suitable flashswap pair found for token ${startToken}`);
        }

        if (DEBUG) {
            console.log('Executing arbitrage with flashswap:', {
                flashLoanPair: flashLoanPair.pairAddress,
                startToken,
                borrowAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                repayFee: flashLoanPair.fee,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        // Send transaction
        const { request } = await this.networkConfig.client.simulateContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrage',
            args: [
                flashLoanPair.pairAddress,    // flashLoanPair
                startToken,                   // startToken
                opportunity.optimalAmount,    // borrowAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees,             // arbFees
                flashLoanPair.fee             // repayFee
            ],
            account: this.networkConfig.account
        });

        const hash = await this.networkConfig.walletClient.writeContract(request);
        
        if (DEBUG) console.log('Transaction sent:', hash);
        
        // Wait for transaction confirmation
        const receipt = await this.networkConfig.client.waitForTransactionReceipt({ hash });
        
        if (DEBUG) {
            console.log('Transaction confirmed:', {
                hash: receipt.transactionHash,
                status: receipt.status
            });
        }

        if (receipt.status === 'reverted') {
            throw new Error('Transaction reverted');
        }
    }

    private async executeDirectly(
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (DEBUG) {
            console.log('Executing arbitrage directly:', {
                startToken: opportunity.path[0],
                startAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        // Send transaction
        const { request } = await this.networkConfig.client.simulateContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrageDirect',
            args: [
                opportunity.path[0],          // startToken
                opportunity.optimalAmount,    // startAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees              // arbFees
            ],
            account: this.networkConfig.account
        });

        const hash = await this.networkConfig.walletClient.writeContract(request);
        
        if (DEBUG) console.log('Transaction sent:', hash);
        
        // Wait for transaction confirmation
        const receipt = await this.networkConfig.client.waitForTransactionReceipt({ hash });
        
        if (DEBUG) {
            console.log('Transaction confirmed:', {
                hash: receipt.transactionHash,
                status: receipt.status
            });
        }

        if (receipt.status === 'reverted') {
            throw new Error('Transaction reverted');
        }
    }
}

// Create and export the opportunity manager factory
export function createOpportunityManager(networkConfig: NetworkConfig): OpportunityManager {
    return new OpportunityManager(networkConfig);
}
