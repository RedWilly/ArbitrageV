//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/UniswapV2Factory.sol";
import "./interfaces/IERC20.sol";
import "forge-std/console.sol";

// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashUniswapQueryV1 {
	function getReservesByPairs(IUniswapV2Pair[] calldata _pairs) external view returns (uint256[3][] memory) {
		uint256[3][] memory result = new uint256[3][](_pairs.length);
		for (uint256 i = 0; i < _pairs.length; i++) {
			(result[i][0], result[i][1], result[i][2]) = _pairs[i].getReserves();
		}
		return result;
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
    address[] calldata baseTokens,
    address[] calldata tokens,
    uint256[] calldata fees,
    uint256[] calldata amountInBases
) external returns (bool[] memory) {
    console.log("\n=== Starting Health Check ===");
    console.log("Number of markets to check:", marketAddresses.length);
    
    require(
        marketAddresses.length == baseTokens.length &&
        baseTokens.length == tokens.length &&
        tokens.length == fees.length &&
        fees.length == amountInBases.length,
        "Array length mismatch"
    );

    bool[] memory results = new bool[](marketAddresses.length);

    for (uint256 i = 0; i < marketAddresses.length; i++) {
        console.log("\n--- Checking Market", i + 1, "---");
        console.log("Market:", marketAddresses[i]);
        console.log("Base Token:", baseTokens[i]);
        console.log("Token:", tokens[i]);
        console.log("Fee:", fees[i]);
        console.log("Amount In:", amountInBases[i]);
        
        bool success = _checkPairHealth(
            marketAddresses[i],
            baseTokens[i],
            tokens[i],
            fees[i],
            amountInBases[i]
        );
        results[i] = success;
        console.log("Health Check Result:", success);
    }

    console.log("\n=== Health Check Complete ===");
    return results;
}

function _checkPairHealth(
    address marketAddress,
    address baseToken,
    address token,
    uint256 fee,
    uint256 amountInBase
) internal returns (bool) {
    console.log("\n=== Starting Pair Health Check ===");
    console.log("Attempting to transfer tokens from sender");
    
    try IERC20(baseToken).transferFrom(msg.sender, address(this), amountInBase) {
        console.log("Token transfer successful");
        IERC20(baseToken).approve(marketAddress, amountInBase);
        console.log("Approved market to spend tokens");
    } catch {
        console.log("Token transfer failed");
        return false;
    }

    console.log("\n--- Executing Buy ---");
    try this._executeBuy(marketAddress, baseToken, token, fee, amountInBase) returns (uint256 boughtAmount) {
        if (boughtAmount == 0) {
            console.log("Buy failed - received 0 tokens");
            return false;
        }
        console.log("Buy successful - received:", boughtAmount);

        console.log("\n--- Executing Sell ---");
        try this._executeSell(marketAddress, baseToken, token, fee, boughtAmount) returns (uint256 returnedBase) {
            console.log("Sell complete - returned base amount:", returnedBase);
            
            if (returnedBase > 0) {
                console.log("Transferring returned base tokens to sender");
                IERC20(baseToken).transfer(msg.sender, returnedBase);
                console.log("Transfer successful");
            }
            
            return returnedBase > 0;
        } catch {
            console.log("Sell execution failed");
            return false;
        }
    } catch {
        console.log("Buy execution failed");
        return false;
    }
}

function _executeBuy(
    address marketAddress,
    address baseToken,
    address token,
    uint256 fee,
    uint256 amountInBase
) external returns (uint256) {
    console.log("\n=== Executing Buy ===");
    console.log("Getting reserves");
    
    (uint256 r0, uint256 r1, ) = IUniswapV2Pair(marketAddress).getReserves();
    console.log("Reserve0:", r0);
    console.log("Reserve1:", r1);
    
    address t0 = IUniswapV2Pair(marketAddress).token0();
    console.log("Token0:", t0);
    console.log("Base token is token0:", t0 == baseToken);
    
    // Approve the pair to spend our base tokens
    IERC20(baseToken).approve(marketAddress, amountInBase);
    console.log("Approved pair to spend base tokens");
    
    // Transfer base tokens to the pair
    IERC20(baseToken).transfer(marketAddress, amountInBase);
    console.log("Transferred base tokens to pair");
    
    uint256 expectedOut = getAmountOut(
        amountInBase,
        t0 == baseToken ? r0 : r1,
        t0 == baseToken ? r1 : r0,
        fee
    );
    console.log("Expected output amount:", expectedOut);

    console.log("Executing swap");
    try IUniswapV2Pair(marketAddress).swap(
        t0 == token ? expectedOut : 0,
        t0 == token ? 0 : expectedOut,
        address(this),
        new bytes(0)
    ) {
        uint256 receivedAmount = IERC20(token).balanceOf(address(this));
        console.log("Swap successful - received amount:", receivedAmount);
        return receivedAmount;
    } catch {
        console.log("Swap failed");
        return 0;
    }
}

function _executeSell(
    address marketAddress,
    address baseToken,
    address token,
    uint256 fee,
    uint256 tokenAmount
) external returns (uint256) {
    console.log("\n=== Executing Sell ===");
    console.log("Getting reserves");
    
    (uint256 r0, uint256 r1, ) = IUniswapV2Pair(marketAddress).getReserves();
    console.log("Reserve0:", r0);
    console.log("Reserve1:", r1);
    
    address t0 = IUniswapV2Pair(marketAddress).token0();
    console.log("Token0:", t0);
    console.log("Base token is token0:", t0 == baseToken);
    
    uint256 expectedReturn = getAmountOut(
        tokenAmount,
        t0 == token ? r0 : r1,
        t0 == token ? r1 : r0,
        fee
    );
    console.log("Expected return amount:", expectedReturn);

    // Approve and transfer tokens to the pair
    IERC20(token).approve(marketAddress, tokenAmount);
    console.log("Approved pair to spend tokens");
    
    IERC20(token).transfer(marketAddress, tokenAmount);
    console.log("Token transfer successful");

    console.log("Executing swap");
    try IUniswapV2Pair(marketAddress).swap(
        t0 == baseToken ? expectedReturn : 0,
        t0 == baseToken ? 0 : expectedReturn,
        address(this),
        new bytes(0)
    ) {
        uint256 receivedBase = IERC20(baseToken).balanceOf(address(this));
        console.log("Swap successful - received base amount:", receivedBase);
        return receivedBase;
    } catch {
        console.log("Swap failed");
        return 0;
    }
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
