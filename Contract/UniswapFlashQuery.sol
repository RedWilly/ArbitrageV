//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/UniswapV2Factory.sol";
import "./interfaces/IERC20.sol";

interface IUniswapV3Pool {
	function liquidity() external view returns (uint128);
	function slot0()
		external
		view
		returns (
			uint160 sqrtPriceX96,
			int24 tick,
			uint16 observationIndex,
			uint16 observationCardinality,
			uint16 observationCardinalityNext,
			uint8 feeProtocol,
			bool unlocked
		);
	function ticks(int24 tick)
		external
		view
		returns (
			uint128 liquidityGross,
			int128 liquidityNet,
			uint256 feeGrowthOutside0X128,
			uint256 feeGrowthOutside1X128,
			int56 tickCumulativeOutside,
			uint160 secondsPerLiquidityOutsideX128,
			uint32 secondsOutside,
			bool initialized
		);
	function tickBitmap(int16 wordPosition) external view returns (uint256);
}

// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashUniswapQueryV1 {
	uint8 private constant V3_STARTUP_BITMAP_WORD_RADIUS = 2;
	uint16 private constant V3_STARTUP_MAX_INITIALIZED_TICKS_PER_POOL = 512;

	struct V3LiveState {
		address pool;
		uint160 sqrtPriceX96;
		int24 tick;
		uint128 liquidity;
	}

	struct V3BitmapData {
		int16 wordPosition;
		uint256 bitmap;
	}

	struct V3TickData {
		int24 tick;
		uint128 liquidityGross;
		int128 liquidityNet;
		bool initialized;
	}

	struct V3StartupState {
		V3LiveState live;
		V3BitmapData[] bitmaps;
		V3TickData[] ticks;
	}

	function getReservesByPairs(IUniswapV2Pair[] calldata _pairs) external view returns (uint256[3][] memory) {
		uint256[3][] memory result = new uint256[3][](_pairs.length);
		for (uint256 i = 0; i < _pairs.length; i++) {
			(result[i][0], result[i][1], result[i][2]) = _pairs[i].getReserves();
		}
		return result;
	}

	function getV3LiveStates(IUniswapV3Pool[] calldata _pools) external view returns (V3LiveState[] memory) {
		V3LiveState[] memory result = new V3LiveState[](_pools.length);
		for (uint256 i = 0; i < _pools.length; i++) {
			result[i] = _getV3LiveState(_pools[i]);
		}
		return result;
	}

	function getV3StartupStatesAroundCurrentTick(
		IUniswapV3Pool[] calldata _pools,
		int24[] calldata _tickSpacings
	) external view returns (V3StartupState[] memory) {
		require(_pools.length == _tickSpacings.length, "Array length mismatch");

		V3StartupState[] memory result = new V3StartupState[](_pools.length);
		for (uint256 i = 0; i < _pools.length; i++) {
			V3LiveState memory live = _getV3LiveState(_pools[i]);
			int16[] memory wordPositions = _getV3StartupWordPositions(live.tick, _tickSpacings[i]);
			V3BitmapData[] memory bitmaps = _getV3TickBitmaps(_pools[i], wordPositions);

			result[i] = V3StartupState({
				live: live,
				bitmaps: bitmaps,
				ticks: _getV3InitializedTicksFromBitmaps(_pools[i], _tickSpacings[i], bitmaps)
			});
		}
		return result;
	}

	function _getV3LiveState(IUniswapV3Pool _pool) internal view returns (V3LiveState memory) {
		(uint160 sqrtPriceX96, int24 tick, , , , , ) = _pool.slot0();
		return V3LiveState({
			pool: address(_pool),
			sqrtPriceX96: sqrtPriceX96,
			tick: tick,
			liquidity: _pool.liquidity()
		});
	}

	function _getV3TickBitmaps(
		IUniswapV3Pool _pool,
		int16[] memory _wordPositions
	) internal view returns (V3BitmapData[] memory) {
		V3BitmapData[] memory result = new V3BitmapData[](_wordPositions.length);
		for (uint256 i = 0; i < _wordPositions.length; i++) {
			result[i] = V3BitmapData({
				wordPosition: _wordPositions[i],
				bitmap: _pool.tickBitmap(_wordPositions[i])
			});
		}
		return result;
	}

	function _getV3StartupWordPositions(
		int24 _tick,
		int24 _tickSpacing
	) internal pure returns (int16[] memory) {
		require(_tickSpacing > 0, "Invalid tick spacing");

		int24 compressed = _tick / _tickSpacing;
		if (_tick < 0 && _tick % _tickSpacing != 0) {
			compressed--;
		}

		int16 centerWord = int16(compressed >> 8);
		uint256 wordCount = uint256(V3_STARTUP_BITMAP_WORD_RADIUS) * 2 + 1;
		int16[] memory result = new int16[](wordCount);
		int16 startWord = centerWord - int16(uint16(V3_STARTUP_BITMAP_WORD_RADIUS));

		for (uint256 i = 0; i < wordCount; i++) {
			result[i] = startWord + int16(uint16(i));
		}

		return result;
	}

	function _getV3InitializedTicksFromBitmaps(
		IUniswapV3Pool _pool,
		int24 _tickSpacing,
		V3BitmapData[] memory _bitmaps
	) internal view returns (V3TickData[] memory) {
		require(_tickSpacing > 0, "Invalid tick spacing");

		V3TickData[] memory temp = new V3TickData[](V3_STARTUP_MAX_INITIALIZED_TICKS_PER_POOL);
		uint256 tickCount = 0;

		for (uint256 wordIndex = 0; wordIndex < _bitmaps.length; wordIndex++) {
			uint256 bitmap = _bitmaps[wordIndex].bitmap;
			if (bitmap == 0) {
				continue;
			}

			for (uint16 bit = 0; bit < 256 && tickCount < V3_STARTUP_MAX_INITIALIZED_TICKS_PER_POOL; bit++) {
				if ((bitmap & (uint256(1) << bit)) == 0) {
					continue;
				}

				int24 tick = int24(
					(int256(_bitmaps[wordIndex].wordPosition) * 256 + int256(uint256(bit))) *
						int256(_tickSpacing)
				);

				temp[tickCount] = _getV3Tick(_pool, tick);
				tickCount++;
			}

			if (tickCount >= V3_STARTUP_MAX_INITIALIZED_TICKS_PER_POOL) {
				break;
			}
		}

		V3TickData[] memory result = new V3TickData[](tickCount);
		for (uint256 i = 0; i < tickCount; i++) {
			result[i] = temp[i];
		}

		return result;
	}

	function _getV3Tick(
		IUniswapV3Pool _pool,
		int24 _tick
	) internal view returns (V3TickData memory) {
			(
				uint128 liquidityGross,
				int128 liquidityNet,
				,
				,
				,
				,
				,
				bool initialized
			) = _pool.ticks(_tick);

			return V3TickData({
				tick: _tick,
				liquidityGross: liquidityGross,
				liquidityNet: liquidityNet,
				initialized: initialized
			});
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
		require(
			marketAddresses.length == baseTokens.length &&
				baseTokens.length == tokens.length &&
				tokens.length == fees.length &&
				fees.length == amountInBases.length,
			"Array length mismatch"
		);

		bool[] memory results = new bool[](marketAddresses.length);

		for (uint256 i = 0; i < marketAddresses.length; i++) {
			bool success = _checkPairHealth(
				marketAddresses[i],
				baseTokens[i],
				tokens[i],
				fees[i],
				amountInBases[i]
			);
			results[i] = success;
		}

		return results;
	}

	function _checkPairHealth(
		address marketAddress,
		address baseToken,
		address token,
		uint256 fee,
		uint256 amountInBase
	) internal returns (bool) {
		try IERC20(baseToken).transferFrom(msg.sender, address(this), amountInBase) {
			IERC20(baseToken).approve(marketAddress, amountInBase);
		} catch {
			return false;
		}

		try this._executeBuy(marketAddress, baseToken, token, fee, amountInBase) returns (uint256 boughtAmount) {
			if (boughtAmount == 0) {
				return false;
			}

			try this._executeSell(marketAddress, baseToken, token, fee, boughtAmount) returns (uint256 returnedBase) {
				if (returnedBase > 0) {
					IERC20(baseToken).transfer(msg.sender, returnedBase);
				}

				return returnedBase > 0;
			} catch {
				return false;
			}
		} catch {
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
		(uint256 r0, uint256 r1, ) = IUniswapV2Pair(marketAddress).getReserves();
		address t0 = IUniswapV2Pair(marketAddress).token0();

		// Approve the pair to spend our base tokens
		IERC20(baseToken).approve(marketAddress, amountInBase);

		// Transfer base tokens to the pair
		IERC20(baseToken).transfer(marketAddress, amountInBase);

		uint256 expectedOut = getAmountOut(
			amountInBase,
			t0 == baseToken ? r0 : r1,
			t0 == baseToken ? r1 : r0,
			fee
		);

		try IUniswapV2Pair(marketAddress).swap(
			t0 == token ? expectedOut : 0,
			t0 == token ? 0 : expectedOut,
			address(this),
			new bytes(0)
		) {
			uint256 receivedAmount = IERC20(token).balanceOf(address(this));
			return receivedAmount;
		} catch {
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
		(uint256 r0, uint256 r1, ) = IUniswapV2Pair(marketAddress).getReserves();
		address t0 = IUniswapV2Pair(marketAddress).token0();

		uint256 expectedReturn = getAmountOut(
			tokenAmount,
			t0 == token ? r0 : r1,
			t0 == token ? r1 : r0,
			fee
		);

		// Approve and transfer tokens to the pair
		IERC20(token).approve(marketAddress, tokenAmount);

		IERC20(token).transfer(marketAddress, tokenAmount);

		try IUniswapV2Pair(marketAddress).swap(
			t0 == baseToken ? expectedReturn : 0,
			t0 == baseToken ? 0 : expectedReturn,
			address(this),
			new bytes(0)
		) {
			uint256 receivedBase = IERC20(baseToken).balanceOf(address(this));
			return receivedBase;
		} catch {
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
