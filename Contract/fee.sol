// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.8.19;
pragma abicoder v2;

import "https://github.com/transmissions11/solmate/blob/main/src/tokens/ERC20.sol";
import "https://github.com/transmissions11/solmate/blob/main/src/utils/SafeTransferLib.sol";
import "https://github.com/transmissions11/solmate/blob/main/src/utils/FixedPointMathLib.sol";
import "./interfaces/UniswapV2Library.sol";

/// @notice Struct of fee related data for a token
struct TokenFees {
    uint256 buyFeeBps;
    uint256 sellFeeBps;
    bool feeTakenOnTransfer;
    bool externalTransferFailed;
    bool sellReverted;
}

contract FeeOnTransferDetector {
    using SafeTransferLib for ERC20;
    using FixedPointMathLib for uint256;

    error SameToken();
    error TokenNotInPair();
    error ArrayLengthMismatch();
    error UnknownExternalTransferFailure(string reason);

    uint256 constant BPS = 10_000;

    /// -----------------------------------------------------------------------
    ///  Universal “Single” Validator
    /// -----------------------------------------------------------------------

    /**
     * @notice A single function that checks fee-on-transfer for any pair (Uniswap or otherwise).
     * @dev The caller must supply the pairAddress, the token address, AND the factory address.
     * @param pairAddress The address of the pair (AMM).
     * @param token The token to test (must be token0 or token1 in the pair).
     * @param factory The factory address (passed explicitly, because some AMMs do not expose pair.factory()).
     * @param amountToBorrow The amount to “flash borrow” for the test.
     */
    function validateAll(
        address pairAddress,
        address token,
        address factory,
        uint256 amountToBorrow
    )
        public
        returns (TokenFees memory fotResult)
    {
        // Internal function that does the same logic:
        return _validateCommon(pairAddress, token, factory, amountToBorrow);
    }

    /// -----------------------------------------------------------------------
    ///  Batch Version
    /// -----------------------------------------------------------------------

    /**
     * @notice Batch version that accepts arrays of pair addresses, tokens, and factories.
     * @dev All arrays must have the same length. The same amountToBorrow is used for each token.
     * @param pairAddresses The list of pairs to check.
     * @param tokens The list of tokens to test (must match pairAddresses).
     * @param factories The list of factory addresses (must match pairAddresses).
     * @param amountToBorrow The amount to borrow for each test.
     */
    function batchValidateAll(
        address[] calldata pairAddresses,
        address[] calldata tokens,
        address[] calldata factories,
        uint256 amountToBorrow
    )
        public
        returns (TokenFees[] memory fotResults)
    {
        if (
            pairAddresses.length != tokens.length
            || tokens.length != factories.length
        ) {
            revert ArrayLengthMismatch();
        }

        fotResults = new TokenFees[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            fotResults[i] = _validateCommon(pairAddresses[i], tokens[i], factories[i], amountToBorrow);
        }
    }

    /// -----------------------------------------------------------------------
    ///  Internal “Common” Validation Logic
    /// -----------------------------------------------------------------------

    function _validateCommon(
        address pairAddress,
        address token,
        address factory,
        uint256 amountToBorrow
    )
        internal
        returns (TokenFees memory result)
    {
        // 1. Verify that the provided token is in the pair.
        address token0Address = IUniswapV2Pair(pairAddress).token0();
        address token1Address = IUniswapV2Pair(pairAddress).token1();

        if (token != token0Address && token != token1Address) {
            revert TokenNotInPair();
        }

        // 2. Figure out the “other” token in the pair (base token).
        address baseToken = (token == token0Address) ? token1Address : token0Address;
        if (token == baseToken) {
            revert SameToken();
        }

        // 3. Calculate how many tokens we want out from the pair in the flash swap.
        (uint256 amount0Out, uint256 amount1Out) =
            token == token0Address ? (amountToBorrow, uint256(0)) : (uint256(0), amountToBorrow);


        // 4. Our current balance of the token, to see how much we receive.
        uint256 detectorBalanceBeforeLoan = ERC20(token).balanceOf(address(this));

        // 5. Encode data for the callback: (oldBalance, amountRequested, factory).
        bytes memory swapData = abi.encode(
            detectorBalanceBeforeLoan,
            amountToBorrow,
            factory
        );

        IUniswapV2Pair pair = IUniswapV2Pair(pairAddress);

        // 6. Initiate the swap; the callback below will revert with TokenFees.
        try pair.swap(amount0Out, amount1Out, address(this), swapData) {
            // If we get here, it means no revert => unexpected.
        } catch (bytes memory reason) {
            // Catch the revert that returns our TokenFees data.
            result = parseRevertReason(reason);
        }
    }

    /// @notice Parse out our custom TokenFees from the revert data.
    function parseRevertReason(bytes memory reason) private pure returns (TokenFees memory) {
        // Our struct is exactly 160 bytes, so anything else is a real revert.
        if (reason.length != 160) {
            assembly {
                revert(add(32, reason), mload(reason))
            }
        } else {
            return abi.decode(reason, (TokenFees));
        }
    }

    /// -----------------------------------------------------------------------
    ///  Pair Callback Logic
    /// -----------------------------------------------------------------------

    // UniswapV2 callback
    function uniswapV2Call(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }

    // Other forks rename the callback:
    function chewyCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function hook(address, uint256 amount0, uint256, bytes calldata data) external {
       _dexCall(msg.sender, amount0, data);
    }
    function miniMeCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function netswapCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function pancakeCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function dogeSwapV2Call(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function YodedexCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function blazeSwapCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function enosysDexCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function pangolinCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function joeCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function VaporDEXCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function lydiaCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function forwardCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function elkCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function yetiswapCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function sicleCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function alligatorCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }
    function hakuswapCall(address, uint256 amount0, uint256, bytes calldata data) external {
        _dexCall(msg.sender, amount0, data);
    }

    /// @notice The common logic that is run inside each of the above callbacks.
    function _dexCall(address pairAddress, uint256 amount0, bytes calldata data) internal {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddress);
        (address token0, address token1) = (pair.token0(), pair.token1());

        ERC20 tokenBorrowed = ERC20(amount0 > 0 ? token0 : token1);

        // Decode our custom data: oldBalance, amountRequested, factory
        (uint256 detectorBalanceBeforeLoan, uint256 amountRequestedToBorrow, address factory) =
            abi.decode(data, (uint256, uint256, address));

        uint256 amountBorrowed = tokenBorrowed.balanceOf(address(this)) - detectorBalanceBeforeLoan;

        // 1. Buy fee
        uint256 buyFeeBps = _calculateBuyFee(amountRequestedToBorrow, amountBorrowed);

        // 2. External transfer test
        (bool feeTakenOnTransfer, bool externalTransferFailed) =
            tryExternalTransferAndRevert(factory, tokenBorrowed, amountBorrowed);

        // 3. Sell fee
        (uint256 sellFeeBps, bool sellReverted) =
            _calculateSellFee(pair, tokenBorrowed, amountBorrowed, buyFeeBps);

        // Encode and revert to bubble up the result.
        bytes memory fees = abi.encode(
            TokenFees({
                buyFeeBps: buyFeeBps,
                sellFeeBps: sellFeeBps,
                feeTakenOnTransfer: feeTakenOnTransfer,
                externalTransferFailed: externalTransferFailed,
                sellReverted: sellReverted
            })
        );
        assembly {
            revert(add(32, fees), mload(fees))
        }
    }

    /// -----------------------------------------------------------------------
    ///  Fee Calculation Helpers
    /// -----------------------------------------------------------------------

    /// @notice Calculate buy fee (in BPS) from difference between requested and received.
    function _calculateBuyFee(uint256 amountRequestedToBorrow, uint256 amountBorrowed)
        internal
        pure
        returns (uint256 buyFeeBps)
    {
        buyFeeBps = (amountRequestedToBorrow - amountBorrowed).mulDivUp(BPS, amountRequestedToBorrow);
    }

    /// @notice Calculate sell fee. If sell reverts, fallback to buy fee.
    function _calculateSellFee(IUniswapV2Pair pair, ERC20 tokenBorrowed, uint256 amountBorrowed, uint256 buyFeeBps)
        internal
        returns (uint256 sellFeeBps, bool sellReverted)
    {
        uint256 pairBalanceBeforeSell = tokenBorrowed.balanceOf(address(pair));
        try this.callTransfer(tokenBorrowed, address(pair), amountBorrowed) {
            uint256 amountSold = tokenBorrowed.balanceOf(address(pair)) - pairBalanceBeforeSell;
            uint256 sellFee = amountBorrowed - amountSold;
            sellFeeBps = sellFee.mulDivUp(BPS, amountBorrowed);
        } catch (bytes memory) {
            sellFeeBps = buyFeeBps;
            sellReverted = true;
        }
    }

    /// -----------------------------------------------------------------------
    ///  External Transfer “Fee on Transfer” Test
    /// -----------------------------------------------------------------------

    /**
     * @notice Tests if the token also takes a fee on normal (non-swap) transfers
     *         or if it reverts in certain conditions.
     * @param factory The factory address we want to send tokens to.
     * @param tokenBorrowed The token to transfer.
     * @param amountBorrowed The amount to transfer.
     * @return feeTakenOnTransfer True if the token took a fee during a normal transfer
     * @return externalTransferFailed True if the token reverts on external transfer.
     */
    function tryExternalTransferAndRevert(
        address factory,
        ERC20 tokenBorrowed,
        uint256 amountBorrowed
    )
        internal
        returns (bool feeTakenOnTransfer, bool externalTransferFailed)
    {
        uint256 balanceBefore = tokenBorrowed.balanceOf(factory);
        // Attempt the transfer, expecting the factory's balance to increase by amountBorrowed
        try this.callTransfer(tokenBorrowed, factory, amountBorrowed, balanceBefore + amountBorrowed) {
            // If it doesn't revert, feeTakenOnTransfer = false means we revert with that data below
        } catch (bytes memory revertData) {
            // If the transfer fails, decode the reason.
            if (revertData.length > 32) {
                assembly {
                    revertData := add(revertData, 0x04)
                }
                string memory reason = abi.decode(revertData, (string));
                if (keccak256(bytes(reason)) == keccak256(bytes("TRANSFER_FAILED"))) {
                    externalTransferFailed = true;
                } else {
                    revert UnknownExternalTransferFailure(reason);
                }
            } else {
                // If we revert with < 32 bytes, it means we have the "feeTakenOnTransfer" boolean
                feeTakenOnTransfer = abi.decode(revertData, (bool));
            }
        }
    }

    /// @notice A small wrapper around safeTransfer, so we can try/catch it in the code above.
    function callTransfer(ERC20 token, address to, uint256 amount) external {
        token.safeTransfer(to, amount);
    }

    /**
     * @notice Another wrapper that reverts with a boolean if a fee was taken, or reverts with a string if the transfer fails.
     * @param token The token to transfer
     * @param to The recipient
     * @param amount The amount to transfer
     * @param expectedBalance The balance we expect `to` to have after the transfer
     */
    function callTransfer(
        ERC20 token,
        address to,
        uint256 amount,
        uint256 expectedBalance
    )
        external
    {
        // First attempt a normal transfer
        try this.callTransfer(token, to, amount) {
            // no-op
        } catch (bytes memory revertData) {
            // If the transfer function itself reverts, bubble up the reason
            if (revertData.length < 68) revert();
            assembly {
                revertData := add(revertData, 0x04)
            }
            revert(abi.decode(revertData, (string)));
        }
        // If it didn't revert, we check if the new balance is what we expected
        bool feeTakenOnTransfer = (token.balanceOf(to) != expectedBalance);
        // Revert with the boolean (caught in the outer try/catch)
        bytes memory revertPayload = abi.encode(feeTakenOnTransfer);
        assembly {
            revert(add(32, revertPayload), mload(revertPayload))
        }
    }
}
