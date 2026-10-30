// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {IOnestableBridgedToken, OnestableDestinationBridge} from "./OnestableDestinationBridge.sol";

interface IOnestableBridgedTokenV2 is IOnestableBridgedToken {
    function isBlacklisted(address _account) external view returns (bool);

    function destroyBlackFunds(address _account) external returns (uint256);
}

contract OnestableDestinationBridgeV2 is OnestableDestinationBridge {
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    uint256 private destroyNonce; // sequential nonce for each dirty funds destroy operation

    /// @notice Track destroy ids of dirty funds destroyed on this chain
    mapping(bytes32 => bool) public destroyedDirtyFunds;

    event DirtyFundsDestroyed(
        bytes32 indexed destroyId,
        address indexed destroyer,
        address indexed account,
        uint256 amount,
        address token,
        uint256 srcChainId,
        address srcTokenAddress
    );

    error AccountNotBlacklisted(address account);

    /// @notice Destroy the entire bridged token balance of a blacklisted account.
    /// @dev The locked backing on the source chain is settled by the relayer, which
    /// consumes `DirtyFundsDestroyed` and calls `settleDestroyedFunds` on the source bridge.
    /// Intentionally not a burn record: a destroy is final and must never be reverted
    /// (reverting would mint the funds back to the blacklisted account).
    /// @param account blacklisted account holding dirty funds
    /// @param srcChainId source chain whose locked supply backs the destroyed funds
    function destroyDirtyFunds(
        address account,
        uint256 srcChainId
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(COMPLIANCE_ROLE)
        returns (bytes32 destroyId)
    {
        IOnestableBridgedTokenV2 token = IOnestableBridgedTokenV2(
            address(bridgedToken)
        );

        if (account == address(0)) revert ZeroAddress("account");
        if (!token.isBlacklisted(account))
            revert AccountNotBlacklisted(account);

        address srcTokenAddress = allowedSourceTokens[srcChainId];
        if (srcTokenAddress == address(0))
            revert InvalidChainId("srcChainId");

        uint256 amount = token.balanceOf(account);
        if (amount == 0) revert InvalidAmount();
        if (totalMintedSupply < amount)
            revert InsufficientMintedSupply(totalMintedSupply, amount);

        uint256 destroyed = token.destroyBlackFunds(account);
        if (destroyed != amount || token.balanceOf(account) != 0)
            revert InvalidAmount();

        destroyNonce += 1;
        totalMintedSupply -= amount;

        destroyId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                account,
                amount,
                address(token),
                srcChainId,
                srcTokenAddress,
                destroyNonce
            )
        );
        destroyedDirtyFunds[destroyId] = true;

        emit DirtyFundsDestroyed(
            destroyId,
            msg.sender,
            account,
            amount,
            address(token),
            srcChainId,
            srcTokenAddress
        );
    }

    // storage gap
    uint256[48] private __gap;
}
