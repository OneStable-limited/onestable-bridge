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

    function confirmLock(
        bytes32 _lockId,
        bytes32 _receipt,
        uint256 _destChainId,
        address _destTokenAddress
    ) external;

    function revertLockedTokens(bytes32 lockId) external;
}

contract OnestableSourceRelayerAdapter is
    OnestableRelayerAdapter,
    ReentrancyGuard
{
    bytes32 public constant UNLOCK_TYPEHASH =
        keccak256(
            "Unlock(bytes32 burnId,uint256 srcChainId,address srcTokenAddress,address sender,address recipient,uint256 amount,uint256 maxConfirmationTimestamp)"
        );
    bytes32 public constant CONFIRM_LOCK_TYPEHASH =
        keccak256(
            "ConfirmLock(bytes32 lockId,bytes32 receipt,uint256 destChainId,address destTokenAddress)"
        );
    bytes32 public constant REVERT_LOCK_TYPEHASH =
        keccak256("RevertLock(bytes32 lockId)");

    IOnestableSourceBridge public immutable bridge;

    constructor(
        address _owner,
        address _authorizedSigner,
        address _bridge
    )
        OnestableRelayerAdapter(
            "OnestableSourceRelayerAdapter",
            "1",
            _owner,
            _authorizedSigner
        )
    {
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
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                UNLOCK_TYPEHASH,
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
        verifySignature(structHash, signature);

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
        uint256 destChainId,
        address destTokenAddress,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                CONFIRM_LOCK_TYPEHASH,
                lockId,
                receipt,
                destChainId,
                destTokenAddress
            )
        );

        // Verify signature
        verifySignature(structHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.confirmLock(lockId, receipt, destChainId, destTokenAddress);
    }

    /// @notice Execute revert for the timeout request
    function executeRevert(
        bytes32 lockId,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(REVERT_LOCK_TYPEHASH, lockId)
        );

        // Verify signature
        verifySignature(structHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.revertLockedTokens(lockId);
    }
}
