// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {IOnestableSourceBridge, OnestableSourceRelayerAdapter} from "./OnestableSourceRelayerAdapter.sol";

interface IOnestableSourceBridgeV2 is IOnestableSourceBridge {
    function settleDestroyedFunds(
        bytes32 destroyId,
        uint256 srcChainId,
        address srcTokenAddress,
        address destroyer,
        address account,
        uint256 amount
    ) external;
}

contract OnestableSourceRelayerAdapterV2 is OnestableSourceRelayerAdapter {
    bytes32 public constant SETTLE_DESTROY_TYPEHASH =
        keccak256(
            "SettleDestroy(bytes32 destroyId,uint256 srcChainId,address srcTokenAddress,address destroyer,address account,uint256 amount)"
        );

    constructor(
        address _owner,
        address _authorizedSigner,
        address _bridge
    ) OnestableSourceRelayerAdapter(_owner, _authorizedSigner, _bridge) {}

    /// @notice Execute settlement of dirty funds destroyed on the destination chain
    function executeSettleDestroy(
        bytes32 destroyId,
        uint256 srcChainId,
        address srcTokenAddress,
        address destroyer,
        address account,
        uint256 amount,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Build EIP712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLE_DESTROY_TYPEHASH,
                destroyId,
                srcChainId,
                srcTokenAddress,
                destroyer,
                account,
                amount
            )
        );

        // Verify signature
        verifySignature(structHash, signature);

        // Forward to bridge (bridge handles replay internally)
        IOnestableSourceBridgeV2(address(bridge)).settleDestroyedFunds(
            destroyId,
            srcChainId,
            srcTokenAddress,
            destroyer,
            account,
            amount
        );
    }
}
