// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OnestableRelayerAdapter} from "../OnestableRelayerAdapter.sol";

interface IOnestableSourceBridge {
    function releaseTokens(
        bytes32 burnId,
        uint256 srcChainId,
        address srcTokenAddress,
        address sender,
        address recipient,
        uint256 amount,
        uint256 maxConfirmationTimestamp
    ) external;

    function confirmLock(bytes32 lockId, bytes32 receipt) external;

    function revertLockedTokens(bytes32 lockId) external;
}

contract OnestableSourceRelayerAdapter is
    OnestableRelayerAdapter,
    ReentrancyGuard
{
    IOnestableSourceBridge public immutable bridge;

    constructor(
        address _owner,
        address _authorizedSigner,
        address _bridge
    ) OnestableRelayerAdapter(_owner, _authorizedSigner) {
        if (_bridge == address(0)) revert ZeroAddress("_bridge");

        bridge = IOnestableSourceBridge(_bridge);
    }

    /// @notice Execute unlock request to the source bridge
    function executeUnlock(
        bytes32 burnId,
        uint256 srcChainId,
        address srcTokenAddress,
        address sender,
        address recipient,
        uint256 amount,
        uint256 maxConfirmationTimestamp,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Compute message hash — deterministic and consistent with off-chain signer
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                burnId,
                srcChainId,
                srcTokenAddress,
                sender,
                recipient,
                amount,
                maxConfirmationTimestamp
            )
        );

        // Verify signature
        verifySignature(messageHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.releaseTokens(
            burnId,
            srcChainId,
            srcTokenAddress,
            sender,
            recipient,
            amount,
            maxConfirmationTimestamp
        );
    }

    /// @notice Execute confirm for the success request
    function executeConfirm(
        bytes32 lockId,
        bytes32 receipt,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Compute message hash — deterministic and consistent with off-chain signer
        bytes32 messageHash = keccak256(abi.encodePacked(lockId, receipt));

        // Verify signature
        verifySignature(messageHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.confirmLock(lockId, receipt);
    }

    /// @notice Execute revert for the timeout request
    function executeRevert(
        bytes32 lockId,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Compute message hash — deterministic and consistent with off-chain signer
        bytes32 messageHash = keccak256(abi.encodePacked(lockId));

        // Verify signature
        verifySignature(messageHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.revertLockedTokens(lockId);
    }
}
