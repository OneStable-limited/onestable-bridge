// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

abstract contract OnestableRelayerAdapter is Ownable, Pausable {
    address public authorizedSigner;

    event SignerChanged(address indexed prevSigner, address indexed newSigner);

    error ZeroAddress(string field);
    error UnauthorizedSigner(address signer);

    constructor(address _owner, address _authorizedSigner) Ownable(_owner) {
        if (_owner == address(0)) revert ZeroAddress("_owner");
        if (_authorizedSigner == address(0))
            revert ZeroAddress("_authorizedSigner");

        authorizedSigner = _authorizedSigner;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setAuthorizedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress("newSigner");

        address prevSigner = authorizedSigner;
        authorizedSigner = newSigner;

        emit SignerChanged(prevSigner, newSigner);
    }

    function verifySignature(
        bytes32 hash,
        bytes calldata signature
    ) internal view {
        // Convert to prefixed message per eth_sign standard
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );

        // Recover signer
        address recovered = ECDSA.recover(ethSignedHash, signature);
        if (recovered != authorizedSigner) revert UnauthorizedSigner(recovered);
    }
}
