// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {OnestableSourceBridge} from "./OnestableSourceBridge.sol";

contract OnestableSourceBridgeV2 is OnestableSourceBridge {
    /// @notice Track if a destroy id has already been settled
    mapping(bytes32 => bool) public processedDestroys;

    event DestroyedFundsSettled(
        bytes32 indexed destroyId,
        address indexed destroyer,
        address indexed account,
        uint256 amount,
        address token,
        uint256 srcChainId,
        address srcTokenAddress
    );

    /// @notice Settle locked tokens which backing dirty funds destroyed on destination chain.
    /// Only callable by authorized message adapter.
    /// @dev Destroyed funds are final on destination chain, so there is no revert path.
    /// The backing locked tokens are only removed from `totalLockedSupply` and stay in this
    /// contract as excess tokens, which admin can withdraw later via `recoverExcessTokens`.
    /// @param destroyId unique id of the destroy operation on destination chain
    /// @param srcChainId chain id where funds were destroyed, must match `destChainId`
    /// @param srcTokenAddress bridged token address on that chain, must match `destTokenAddress`
    /// @param destroyer address which destroyed the funds on destination chain
    /// @param account blacklisted account whose funds were destroyed
    /// @param amount amount of destroyed funds
    function settleDestroyedFunds(
        bytes32 destroyId,
        uint256 srcChainId,
        address srcTokenAddress,
        address destroyer,
        address account,
        uint256 amount
    ) external whenNotPaused nonReentrant onlyRole(MESSAGE_ADAPTER_ROLE) {
        if (destroyId == bytes32(0)) revert InvalidId();
        if (srcChainId == 0) revert InvalidChainId("srcChainId");
        if (srcTokenAddress == address(0))
            revert ZeroAddress("srcTokenAddress");
        if (amount == 0) revert InvalidAmount();
        if (processedDestroys[destroyId]) revert AlreadyProcessed();
        if (srcChainId != destChainId)
            revert ReleaseNotAllowedFromSource(destChainId, srcChainId);
        if (srcTokenAddress != destTokenAddress)
            revert ReleaseNotAllowedFromSourceToken(
                destTokenAddress,
                srcTokenAddress
            );
        if (totalLockedSupply < amount)
            revert InsufficientLockedSupply(totalLockedSupply, amount);

        processedDestroys[destroyId] = true;

        // Backing tokens stay in this contract as excess tokens
        totalLockedSupply -= amount;

        emit DestroyedFundsSettled(
            destroyId,
            destroyer,
            account,
            amount,
            address(token),
            srcChainId,
            srcTokenAddress
        );
    }

    // storage gap
    uint256[49] private __gap;
}
