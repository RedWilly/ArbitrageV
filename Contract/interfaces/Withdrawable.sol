// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";

abstract contract Withdrawable {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    // Function to withdraw ERC20 tokens
    function withdrawToken(address tokenAddress, uint256 amount) external onlyOwner {
        IERC20 token = IERC20(tokenAddress);
        bool success = token.transfer(owner, amount);
        require(success, "Token transfer failed");
    }

    // Function to withdraw native tokens (e.g., ETH, METIS)
    function withdrawNative(uint256 amount) external onlyOwner {
        payable(owner).transfer(amount);
    }

    // Function to withdraw all native tokens
    function withdrawAllNative() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(owner).transfer(balance);
    }

    // Function to withdraw all of a specific ERC20 token
    function withdrawAllToken(address tokenAddress) external onlyOwner {
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        bool success = token.transfer(owner, balance);
        require(success, "Token transfer failed");
    }

    // Function to transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be the zero address");
        owner = newOwner;
    }

    // Fallback function to receive Ether
    receive() external payable {}
}