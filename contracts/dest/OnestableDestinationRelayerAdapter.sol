// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OnestableRelayerAdapter} from "../OnestableRelayerAdapter.sol";

interface IOnestableDestinationBridge {
    function mintTokens(
        bytes32 lockId,
        uint256 srcChainId,
        address srcTokenAddress,
        address sender,
        address recipient,
        uint256 amount,
        uint256 maxConfirmationTimestamp
    ) external;

    function confirmBurn(bytes32 burnId, bytes32 receipt) external;

    function revertBurnedTokens(bytes32 burnId) external;
}

contract OnestableDestinationRelayerAdapter is
    OnestableRelayerAdapter,
    ReentrancyGuard
{
    IOnestableDestinationBridge public immutable bridge;

    constructor(
        address _owner,
        address _authorizedSigner,
        address _bridge
    ) OnestableRelayerAdapter(_owner, _authorizedSigner) {
        if (_bridge == address(0)) revert ZeroAddress("_bridge");

        bridge = IOnestableDestinationBridge(_bridge);
    }

    /// @notice Execute mint request to the destination bridge
    function executeMint(
        bytes32 lockId,
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
                lockId,
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
        bridge.mintTokens(
            lockId,
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
        bytes32 burnId,
        bytes32 receipt,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Compute message hash — deterministic and consistent with off-chain signer
        bytes32 messageHash = keccak256(abi.encodePacked(burnId, receipt));

        // Verify signature
        verifySignature(messageHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.confirmBurn(burnId, receipt);
    }

    /// @notice Execute revert for the timeout request
    function executeRevert(
        bytes32 burnId,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Compute message hash — deterministic and consistent with off-chain signer
        bytes32 messageHash = keccak256(abi.encodePacked(burnId));

        // Verify signature
        verifySignature(messageHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.revertBurnedTokens(burnId);
    }
}
