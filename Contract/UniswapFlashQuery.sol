//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IUniswapV3Pool.sol";
import "./interfaces/UniswapV2Factory.sol";
import "./interfaces/IERC20.sol";


// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashUniswapQueryV12 {
    // V2 calling
	function getReservesByPairs(IUniswapV2Pair[] calldata _pairs) external view returns (uint256[3][] memory) {
		uint256[3][] memory result = new uint256[3][](_pairs.length);
		for (uint256 i = 0; i < _pairs.length; i++) {
			(result[i][0], result[i][1], result[i][2]) = _pairs[i].getReserves();
		}
		return result;
	}

    // v3
    function getReservesByV3Pools(IUniswapV3PoolState[] calldata _pools) external view returns (int24[] memory, uint128[] memory, uint160[] memory) {
        uint256 length = _pools.length;
        int24[] memory ticks = new int24[](length);
        uint128[] memory liquidities = new uint128[](length);
        uint160[] memory sqrtPricesX96 = new uint160[](length);
        
        for (uint256 i = 0; i < length; i++) {
            (uint160 sqrtPriceX96, int24 tick, , , , , ) = _pools[i].slot0();
            uint128 liquidity = _pools[i].liquidity();
            
            sqrtPricesX96[i] = sqrtPriceX96;
            ticks[i] = tick;
            liquidities[i] = liquidity;
        }
        
        return (ticks, liquidities, sqrtPricesX96);
    }

	function getPairsByIndexRange(
		UniswapV2Factory _uniswapFactory,
		uint256 _start,
		uint256 _stop
	) external view returns (address[3][] memory) {
		uint256 _allPairsLength = _uniswapFactory.allPairsLength();
		if (_stop > _allPairsLength) {
			_stop = _allPairsLength;
		}
		require(_stop >= _start, "start cannot be higher than stop");
		uint256 _qty = _stop - _start;
		address[3][] memory result = new address[3][](_qty);
		for (uint256 i = 0; i < _qty; i++) {
			IUniswapV2Pair _uniswapPair = IUniswapV2Pair(_uniswapFactory.allPairs(_start + i));
			result[i][0] = _uniswapPair.token0();
			result[i][1] = _uniswapPair.token1();
			result[i][2] = address(_uniswapPair);
		}
		return result;
	}

	function getPairsByIndexRange1(
		UniswapV2Factory _uniswapFactory,
		uint256 _start,
		uint256 _stop
	) external view returns (address[3][] memory) {
		uint256 _allPairsLength = _uniswapFactory.allPairsLength();
		if (_stop > _allPairsLength) {
			_stop = _allPairsLength;
		}
		require(_stop >= _start, "start cannot be higher than stop");

		// Calculate the timestamp for 45 days ago
		uint256 thirtyDaysAgo = block.timestamp - 45 days;

		// Temporary array to store active pairs
		address[3][] memory tempResult = new address[3][](_stop - _start);
		uint256 activePairCount = 0;

		// Iterate through the range of pairs
		for (uint256 i = 0; i < _stop - _start; i++) {
			IUniswapV2Pair _uniswapPair = IUniswapV2Pair(_uniswapFactory.allPairs(_start + i));

			// Get the reserves and the last block timestamp
			(, , uint256 blockTimestampLast) = _uniswapPair.getReserves();

			// Check if the pair was active in the last 30 days
			if (blockTimestampLast >= thirtyDaysAgo) {
				tempResult[activePairCount][0] = _uniswapPair.token0();
				tempResult[activePairCount][1] = _uniswapPair.token1();
				tempResult[activePairCount][2] = address(_uniswapPair);
				activePairCount++;
			}
		}

		// Create the final result array with the correct size
		address[3][] memory result = new address[3][](activePairCount);
		for (uint256 i = 0; i < activePairCount; i++) {
			result[i] = tempResult[i];
		}

		return result;
	}

    //v3
    function getPools0or1(IUniswapV3PoolState[] calldata _pools) 
        external view 
        returns (address[2][] memory) 
    {
        address[2][] memory result = new address[2][](_pools.length);
        for (uint256 i = 0; i < _pools.length; i++) {
            result[i][0] = _pools[i].token0();
            result[i][1] = _pools[i].token1();
        }
        return result;
    }

	function filterVolatileHermesPairs(IBaseV1Pair[] calldata _pairs) external view returns (bool[] memory) {
		bool[] memory result = new bool[](_pairs.length);
		for (uint256 i = 0; i < _pairs.length; i++) {
			(, , , , result[i], , ) = _pairs[i].metadata();
		}
		return result;
	}

    function getPairsLength(UniswapV2Factory[] calldata _factories) external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](_factories.length);
        for (uint256 i = 0; i < _factories.length; i++) {
            result[i] = _factories[i].allPairsLength();
        }
        return result;
    }


    // Modified health check with cleanup
function healthCheck(
    address[] calldata marketAddresses,
    address[] calldata tokens,
    address baseToken,
    uint256 amountInBase
) external returns (bool[] memory) {
    require(marketAddresses.length == tokens.length, "Array length mismatch");
    bool[] memory results = new bool[](marketAddresses.length);
    uint256 fee = 30; // 0.3% fee if using Uniswap V2

    for (uint256 i = 0; i < marketAddresses.length; i++) {
        bool success = false;
        try this._singlePairCheck(
            marketAddresses[i],
            baseToken,
            tokens[i],
            fee,
            amountInBase
        ) {
            success = true;
        } catch {}
        
        results[i] = success;
    }
    return results;
}

function _singlePairCheck(
    address marketAddress,
    address baseToken,
    address token,
    uint256 fee,
    uint256 amountInBase
) external {
    // Buy check
    (uint256 r0, uint256 r1,) = IUniswapV2Pair(marketAddress).getReserves();
    address t0 = IUniswapV2Pair(marketAddress).token0();
    
    // Validate pair composition
    require((t0 == baseToken && IUniswapV2Pair(marketAddress).token1() == token) ||
            (t0 == token && IUniswapV2Pair(marketAddress).token1() == baseToken), 
            "Invalid pair");

    // Transfer base tokens from sender to contract
    require(IERC20(baseToken).transferFrom(msg.sender, address(this), amountInBase), "Transfer failed");
    
    // Calculate expected output
    uint256 expectedOut = getAmountOut(
        amountInBase,
        t0 == baseToken ? r0 : r1,
        t0 == baseToken ? r1 : r0,
        fee
    );

    // Execute buy
    IUniswapV2Pair(marketAddress).swap(
        t0 == baseToken ? 0 : expectedOut,
        t0 == baseToken ? expectedOut : 0,
        address(this),
        ""
    );

    // Verify buy results
    uint256 boughtAmount = IERC20(token).balanceOf(address(this));
    require(boughtAmount >= expectedOut, "Buy check failed");

    // Sell check
    uint256 expectedReturn = getAmountOut(
        boughtAmount,
        t0 == baseToken ? r1 : r0,
        t0 == baseToken ? r0 : r1,
        fee
    );

    // Execute sell
    require(IERC20(token).transfer(marketAddress, boughtAmount), "Token transfer failed");
    IUniswapV2Pair(marketAddress).swap(
        t0 == baseToken ? expectedReturn : 0,
        t0 == baseToken ? 0 : expectedReturn,
        address(this),
        ""
    );

    // Verify sell results and cleanup
    uint256 finalBase = IERC20(baseToken).balanceOf(address(this));
    require(finalBase >= amountInBase, "Sell check failed");
    
    // Return funds to sender
    IERC20(baseToken).transfer(msg.sender, finalBase);
}

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 fee
    ) public pure returns (uint256) {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "Invalid input");
        uint256 amountInWithFee = amountIn * (10000 - fee);
        return (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
    }

}
