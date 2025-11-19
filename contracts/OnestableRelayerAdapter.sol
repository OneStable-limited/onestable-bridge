// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

abstract contract OnestableRelayerAdapter is Ownable, Pausable, EIP712 {
    address public authorizedSigner;

    event SignerChanged(address indexed prevSigner, address indexed newSigner);

    error ZeroAddress(string field);
    error EmptyString(string field);
    error UnauthorizedSigner(address signer);

    constructor(
        string memory _name,
        string memory _version,
        address _owner,
        address _authorizedSigner
    ) Ownable(_owner) EIP712(_name, _version) {
        if (bytes(_name).length == 0) revert EmptyString("_name");
        if (bytes(_version).length == 0) revert EmptyString("_version");
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
        bytes32 structHash,
        bytes calldata signature
    ) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);

        // Recover signer
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != authorizedSigner) revert UnauthorizedSigner(recovered);
    }
}
