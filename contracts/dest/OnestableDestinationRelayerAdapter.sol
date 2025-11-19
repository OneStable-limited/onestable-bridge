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

    function confirmBurn(
        bytes32 burnId,
        bytes32 receipt,
        uint256 destChainId,
        address destTokenAddress
    ) external;

    function revertBurnedTokens(bytes32 burnId) external;
}

contract OnestableDestinationRelayerAdapter is
    OnestableRelayerAdapter,
    ReentrancyGuard
{
    bytes32 public constant MINT_TYPEHASH =
        keccak256(
            "Mint(bytes32 lockId,uint256 srcChainId,address srcTokenAddress,address sender,address recipient,uint256 amount,uint256 maxConfirmationTimestamp)"
        );
    bytes32 public constant CONFIRM_BURN_TYPEHASH =
        keccak256(
            "ConfirmBurn(bytes32 burnId,bytes32 receipt,uint256 destChainId,address destTokenAddress)"
        );
    bytes32 public constant REVERT_BURN_TYPEHASH =
        keccak256("RevertBurn(bytes32 burnId)");

    IOnestableDestinationBridge public immutable bridge;

    constructor(
        address _owner,
        address _authorizedSigner,
        address _bridge
    )
        OnestableRelayerAdapter(
            "OnestableDestinationRelayerAdapter",
            "1",
            _owner,
            _authorizedSigner
        )
    {
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
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                MINT_TYPEHASH,
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
        verifySignature(structHash, signature);

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
        uint256 destChainId,
        address destTokenAddress,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                CONFIRM_BURN_TYPEHASH,
                burnId,
                receipt,
                destChainId,
                destTokenAddress
            )
        );

        // Verify signature
        verifySignature(structHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.confirmBurn(burnId, receipt, destChainId, destTokenAddress);
    }

    /// @notice Execute revert for the timeout request
    function executeRevert(
        bytes32 burnId,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(REVERT_BURN_TYPEHASH, burnId)
        );

        // Verify signature
        verifySignature(structHash, signature);

        // Forward to bridge (bridge handles replay internally)
        bridge.revertBurnedTokens(burnId);
    }
}
