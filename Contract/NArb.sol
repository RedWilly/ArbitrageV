// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/Withdrawable.sol";
import "./interfaces/IUniswapV2Pair.sol";

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface ICarbonController {
    struct TradeAction {
        uint256 strategyId;
        uint128 amount;
    }

    function tradeBySourceAmount(
        address sourceToken,
        address targetToken,
        TradeAction[] calldata tradeActions,
        uint256 deadline,
        uint128 minReturn
    ) external payable returns (uint128);
}

interface IWSEI {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

error ArrayLengthMismatch();
error StartTokenNotInFlashLoanPair();
error ArbitrageMustReturnToStart();
error RepaymentTransferFailed();
error InsufficientFlashLoanRepayment();
error SwapPathError();
error InvalidReserves();
error OutputExceedsReserve();
error TokenTransferFailed();
error UnsupportedProtocol();
error InvalidV3SwapCallback();
error InvalidV3SwapDelta();
error InvalidFlashLoanCallback();
error InvalidCarbonAmount();
error CarbonApprovalFailed();

contract ArbitrageExecutor is Withdrawable {
    uint8 private constant V2 = 0;
    uint8 private constant V3 = 1;
    uint8 private constant CARBON = 2;
    address private constant NATIVE_SEI = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address private constant WSEI = 0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7;
    uint256 private constant FEE_DENOMINATOR = 10000;
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    uint8 private pendingFlashProtocol;
    address private pendingFlashPool;
    address private pendingV3Pool;
    address private pendingV3TokenIn;

    struct FlashData {
        address borrowedToken;
        uint256 borrowedAmount;
        bool borrowedToken0;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
    }

    struct ArbParams {
        uint8 flashProtocol;
        address flashPool;
        address borrowToken;
        uint256 borrowAmount;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
    }

    constructor(address owner_) Withdrawable(owner_) {}

    function executeArbitrage(ArbParams calldata params) external {
        _checkRoute(params.pools, params.protocols, params.fees, params.data);
        bool borrowToken0 = _isToken0(params.flashPool, params.borrowToken);
        _startFlashLoan(params, borrowToken0, _flashData(params, borrowToken0));
    }

    function _startFlashLoan(
        ArbParams calldata params,
        bool borrowToken0,
        bytes memory data
    ) internal {
        pendingFlashProtocol = params.flashProtocol;
        pendingFlashPool = params.flashPool;

        if (params.flashProtocol == V2) {
            IUniswapV2Pair(params.flashPool).swap(
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                address(this),
                data
            );
        } else if (params.flashProtocol == V3) {
            IUniswapV3Pool(params.flashPool).flash(
                address(this),
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                data
            );
        } else {
            revert UnsupportedProtocol();
        }

        pendingFlashProtocol = 0;
        pendingFlashPool = address(0);
    }

    // ponytail: one generic fallback handles callback name variants instead of dozens of wrappers.
    fallback() external payable {
        if (msg.sender == pendingV3Pool && pendingV3TokenIn != address(0)) {
            (int256 amount0Delta, int256 amount1Delta, ) =
                abi.decode(msg.data[4:], (int256, int256, bytes));
            _finishV3SwapCallback(amount0Delta, amount1Delta);
            return;
        }

        if (msg.sender != pendingFlashPool || msg.data.length < 132) {
            revert InvalidFlashLoanCallback();
        }

        if (pendingFlashProtocol == V3) {
            (uint256 fee0, uint256 fee1, bytes memory flashPayload) =
                abi.decode(msg.data[4:], (uint256, uint256, bytes));
            FlashData memory v3Loan = abi.decode(flashPayload, (FlashData));
            _finishFlashLoan(v3Loan, v3Loan.borrowedAmount + (v3Loan.borrowedToken0 ? fee0 : fee1));
            return;
        }

        if (pendingFlashProtocol != V2) revert InvalidFlashLoanCallback();

        (address sender, uint256 amount0, uint256 amount1, bytes memory data) =
            abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        if (sender != address(this)) revert InvalidFlashLoanCallback();

        FlashData memory loan = abi.decode(data, (FlashData));
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        if (borrowedAmount != loan.borrowedAmount) revert InvalidFlashLoanCallback();

        _finishFlashLoan(
            loan,
            borrowedAmount + ((borrowedAmount * loan.v2RepayFee) / (FEE_DENOMINATOR - loan.v2RepayFee)) + 1
        );
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (pendingFlashProtocol != V3 || msg.sender != pendingFlashPool) {
            revert InvalidFlashLoanCallback();
        }

        FlashData memory loan = abi.decode(data, (FlashData));
        _finishFlashLoan(loan, loan.borrowedAmount + (loan.borrowedToken0 ? fee0 : fee1));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        data;
        _finishV3SwapCallback(amount0Delta, amount1Delta);
    }

    function _finishV3SwapCallback(int256 amount0Delta, int256 amount1Delta) internal {
        address tokenIn = pendingV3TokenIn;
        if (msg.sender != pendingV3Pool || tokenIn == address(0)) revert InvalidV3SwapCallback();

        if (amount0Delta > 0 && amount1Delta <= 0) {
            _safeTransfer(tokenIn, msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0 && amount0Delta <= 0) {
            _safeTransfer(tokenIn, msg.sender, uint256(amount1Delta));
        } else {
            revert InvalidV3SwapDelta();
        }
    }

    function _finishFlashLoan(FlashData memory loan, uint256 repayAmount) internal {
        uint256 finalAmount = _executeCircularRoute(
            loan.borrowedToken,
            loan.borrowedAmount,
            loan.pools,
            loan.protocols,
            loan.fees,
            loan.data
        );

        if (finalAmount < repayAmount) revert InsufficientFlashLoanRepayment();
        if (!IERC20(loan.borrowedToken).transfer(msg.sender, repayAmount)) {
            revert RepaymentTransferFailed();
        }
    }

    function _executeCircularRoute(
        address startToken,
        uint256 startAmount,
        address[] memory pools,
        uint8[] memory protocols,
        uint256[] memory fees,
        bytes[] memory data
    ) internal returns (uint256) {
        address token = startToken;
        uint256 amount = startAmount;

        for (uint256 i; i < pools.length; ) {
            if (protocols[i] == V2) {
                (token, amount) = _swapV2(token, amount, pools[i], fees[i]);
            } else if (protocols[i] == V3) {
                (token, amount) = _swapV3(token, amount, pools[i]);
            } else if (protocols[i] == CARBON) {
                (token, amount) = _swapCarbon(token, amount, pools[i], data[i]);
            } else {
                revert UnsupportedProtocol();
            }

            unchecked { ++i; }
        }

        if (token != startToken) revert ArbitrageMustReturnToStart();
        return amount;
    }

    function _swapV2(
        address tokenIn,
        uint256 amountIn,
        address pairAddr,
        uint256 fee
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        address token0 = pair.token0();
        address token1 = pair.token1();
        bool zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        amountOut = _v2AmountOut(amountIn, reserveIn, reserveOut, fee);
        if (amountOut >= reserveOut) revert OutputExceedsReserve();

        _safeTransfer(tokenIn, pairAddr, amountIn);
        pair.swap(
            zeroForOne ? 0 : amountOut,
            zeroForOne ? amountOut : 0,
            address(this),
            new bytes(0)
        );

        tokenOut = zeroForOne ? token1 : token0;
    }

    function _swapV3(
        address tokenIn,
        uint256 amountIn,
        address poolAddr
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddr);
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        tokenOut = zeroForOne ? token1 : token0;
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        pendingV3Pool = poolAddr;
        pendingV3TokenIn = tokenIn;
        pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            new bytes(0)
        );
        pendingV3Pool = address(0);
        pendingV3TokenIn = address(0);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        if (amountOut == 0) revert SwapPathError();
    }

    function _swapCarbon(
        address tokenIn,
        uint256 amountIn,
        address controller,
        bytes memory data
    ) internal returns (address tokenOut, uint256 amountOut) {
        if (amountIn > type(uint128).max) revert InvalidCarbonAmount();

        address rawSourceToken;
        address rawTargetToken;
        uint256[] memory strategyIds;
        uint128[] memory amounts;
        if (data.length == 96) {
            uint256 strategyId;
            (strategyId, rawSourceToken, rawTargetToken) = abi.decode(data, (uint256, address, address));
            strategyIds = new uint256[](1);
            amounts = new uint128[](1);
            strategyIds[0] = strategyId;
            amounts[0] = uint128(amountIn);
        } else {
            (rawSourceToken, rawTargetToken, strategyIds, amounts) =
                abi.decode(data, (address, address, uint256[], uint128[]));
        }
        bool sourceIsNative = rawSourceToken == NATIVE_SEI;
        bool targetIsNative = rawTargetToken == NATIVE_SEI;
        tokenOut = targetIsNative ? WSEI : rawTargetToken;
        if (sourceIsNative && tokenIn != WSEI) revert SwapPathError();
        if (!sourceIsNative && tokenIn != rawSourceToken) revert SwapPathError();
        if (strategyIds.length == 0 || strategyIds.length != amounts.length) revert SwapPathError();

        if (sourceIsNative) {
            IWSEI(WSEI).withdraw(amountIn);
        } else {
            _approveCarbonIfNeeded(tokenIn, controller, amountIn);
        }

        uint256 balanceBefore = targetIsNative
            ? address(this).balance
            : IERC20(rawTargetToken).balanceOf(address(this));

        ICarbonController.TradeAction[] memory actions = new ICarbonController.TradeAction[](strategyIds.length);
        uint256 totalActionAmount;
        for (uint256 i; i < strategyIds.length; ) {
            totalActionAmount += amounts[i];
            actions[i] = ICarbonController.TradeAction({
                strategyId: strategyIds[i],
                amount: amounts[i]
            });
            unchecked { ++i; }
        }
        if (totalActionAmount != amountIn) revert InvalidCarbonAmount();

        ICarbonController(controller).tradeBySourceAmount{value: sourceIsNative ? amountIn : 0}(
            rawSourceToken,
            rawTargetToken,
            actions,
            block.timestamp,
            1
        );

        if (targetIsNative) {
            amountOut = address(this).balance - balanceBefore;
            IWSEI(WSEI).deposit{value: amountOut}();
        } else {
            amountOut = IERC20(rawTargetToken).balanceOf(address(this)) - balanceBefore;
        }

        if (amountOut == 0) revert SwapPathError();
    }

    function _approveCarbonIfNeeded(address token, address controller, uint256 amount) internal {
        uint256 allowance = IERC20(token).allowance(address(this), controller);
        if (allowance >= amount) return;

        if (allowance != 0 && !IERC20(token).approve(controller, 0)) revert CarbonApprovalFailed();
        if (!IERC20(token).approve(controller, type(uint256).max)) revert CarbonApprovalFailed();
    }

    function _isToken0(address pool, address token) internal view returns (bool) {
        address token0 = IUniswapV2Pair(pool).token0();
        if (token == token0) return true;
        if (token != IUniswapV2Pair(pool).token1()) revert StartTokenNotInFlashLoanPair();
        return false;
    }

    function _flashData(ArbParams calldata params, bool borrowedToken0) internal pure returns (bytes memory) {
        return abi.encode(FlashData({
            borrowedToken: params.borrowToken,
            borrowedAmount: params.borrowAmount,
            borrowedToken0: borrowedToken0,
            v2RepayFee: params.v2RepayFee,
            pools: params.pools,
            protocols: params.protocols,
            fees: params.fees,
            data: params.data
        }));
    }

    function _v2AmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - fee);
        return (amountInWithFee * reserveOut) / ((reserveIn * FEE_DENOMINATOR) + amountInWithFee);
    }

    function _checkRoute(
        address[] calldata pools,
        uint8[] calldata protocols,
        uint256[] calldata fees,
        bytes[] calldata data
    ) internal pure {
        if (pools.length != protocols.length || pools.length != fees.length || pools.length != data.length) {
            revert ArrayLengthMismatch();
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }
}
