// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

interface IOnestableBridgedToken is IERC20 {
    function mint(address _to, uint256 _amount) external returns (bool);

    function burn(uint256 _amount) external;

    function totalSupply() external view returns (uint256);
}

contract OnestableDestinationBridge is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using SafeERC20 for IOnestableBridgedToken;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant MESSAGE_ADAPTER_ROLE =
        keccak256("MESSAGE_ADAPTER_ROLE");

    struct BurnRecord {
        address sender;
        address recipient;
        uint256 amount;
        address token;
        uint256 destChainId;
        address destTokenAddress;
        uint256 maxConfirmationTimestamp;
        uint256 nonce;
    }

    uint256 private nonce; // sequential nonce for each burn operation

    IOnestableBridgedToken public bridgedToken;
    uint256 public totalMintedSupply;
    uint256 public maxConfirmationPeriod;

    /// @notice Track if a lock id has already been processed
    mapping(bytes32 => bool) public processedMints;

    /// @notice Mapping of burn id to unsettled burn record
    mapping(bytes32 => BurnRecord) public burnRecords;

    /// @notice Maps burn id => source chain confirmation tx hash
    mapping(bytes32 => bytes32) public confirmedBurnReceipts;

    /// @notice Track if a burn is reverted
    mapping(bytes32 => bool) public isBurnReverted;

    /// @notice Allowed source chain token address (srcChainId => srcTokenAddress)
    mapping(uint256 => address) public allowedSourceTokens;

    event AllowedSourceTokenUpdated(
        uint256 indexed chainId,
        address tokenAddress
    );
    event TokensMinted(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        address token,
        uint256 srcChainId,
        address srcTokenAddress
    );
    event TokensBurned(
        bytes32 indexed burnId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        address token,
        uint256 maxConfirmationTimestamp,
        uint256 destChainId,
        address destTokenAddress
    );
    event BurnConfirmed(bytes32 indexed burnId, bytes32 indexed receipt);
    event RevertedBurnedTokens(
        bytes32 indexed burnId,
        address indexed recipient,
        uint256 amount
    );

    error ZeroAddress(string field);
    error InvalidAmount();
    error ArrayLengthMismatch(string field1, string field2);
    error AlreadyProcessed();
    error InvalidChainId(string field);
    error InvalidId();
    error InvalidConfirmationPeriod(uint256 provided, uint256 min, uint256 max);
    error BurnForDestinationChainNotAllowed(uint256 chainId);
    error InsufficientMintedSupply(uint256 available, uint256 required);
    error MintNotAllowedFromSource(uint256 chainId);
    error MintNotAllowedFromSourceToken(
        address allowedTokenAddress,
        address srcTokenAddress
    );
    error MintTokensFailed(address recipient, uint256 amount);
    error RequestTimeout(uint256 current, uint256 maxConfirmationTimestamp);
    error RevertBurnedTokensTooEarly(
        uint256 current,
        uint256 maxConfirmationTimestamp
    );
    error RevertNotAllowed(bytes32 burnId);
    error ConfirmBurnNotAllowed(bytes32 burnId);
    error DestinationChainNotAllowed(uint256 allowed, uint256 provided);
    error DestinationTokenNotAllowed(address allowed, address provided);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IOnestableBridgedToken _bridgedToken,
        uint256[] memory _srcChainIds,
        address[] memory _srcTokenAddresses,
        uint256 _maxConfirmationPeriod,
        address _defaultAdmin,
        address _pauser,
        address _upgrader
    ) public initializer {
        if (address(_bridgedToken) == address(0))
            revert ZeroAddress("_bridgedToken");
        if (_defaultAdmin == address(0)) revert ZeroAddress("_defaultAdmin");
        if (_pauser == address(0)) revert ZeroAddress("_pauser");
        if (_upgrader == address(0)) revert ZeroAddress("_upgrader");
        if (_srcChainIds.length != _srcTokenAddresses.length)
            revert ArrayLengthMismatch("_srcChainIds", "_srcTokenAddresses");

        __Pausable_init();
        __ReentrancyGuard_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
        _grantRole(PAUSER_ROLE, _pauser);
        _grantRole(UPGRADER_ROLE, _upgrader);

        bridgedToken = _bridgedToken;
        maxConfirmationPeriod = _maxConfirmationPeriod;

        for (uint256 i = 0; i < _srcChainIds.length; i++) {
            _setAllowedSourceTokens(_srcChainIds[i], _srcTokenAddresses[i]);
        }
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Grant or revoke message adapter role (admin controlled)
    function setMessageAdapter(
        address adapter,
        bool enabled
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress("adapter");

        if (enabled) {
            _grantRole(MESSAGE_ADAPTER_ROLE, adapter);
        } else {
            _revokeRole(MESSAGE_ADAPTER_ROLE, adapter);
        }
    }

    function _setAllowedSourceTokens(
        uint256 chainId,
        address tokenAddress
    ) internal {
        if (chainId == block.chainid) revert InvalidChainId("chainId");

        allowedSourceTokens[chainId] = tokenAddress;

        emit AllowedSourceTokenUpdated(chainId, tokenAddress);
    }

    /// @notice Grant or revoke source tokens (admin controlled)
    function setAllowedSourceTokens(
        uint256 chainId,
        address tokenAddress
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        _setAllowedSourceTokens(chainId, tokenAddress);
    }

    /// @notice Admin can adjust confirmation period
    /// @dev Event emission not needed
    function setMaxConfirmationPeriod(
        uint256 _maxPeriod
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxPeriod < 300 || _maxPeriod > 86400)
            revert InvalidConfirmationPeriod(_maxPeriod, 300, 86400);

        maxConfirmationPeriod = _maxPeriod;
    }

    /**
     * @notice Rescue ERC20 tokens locked up in this contract.
     * @param tokenContract ERC20 token contract address
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function rescueERC20(
        IERC20 tokenContract,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress("to");
        if (amount == 0) revert InvalidAmount();

        tokenContract.safeTransfer(to, amount);
    }

    function _getBurnId(
        BurnRecord memory burnRecord
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    burnRecord.sender,
                    burnRecord.recipient,
                    burnRecord.amount,
                    burnRecord.token,
                    burnRecord.destChainId,
                    burnRecord.destTokenAddress,
                    burnRecord.maxConfirmationTimestamp,
                    burnRecord.nonce
                )
            );
    }

    /// @notice Burn bridged tokens and create an on-chain event that adapters will consume to unlock tokens on the source chain.
    /// @dev Caller must approve this bridge to spend `amount` on the bridged token.
    /// @param destChainId destination chain id
    /// @param recipient recipient address on source chain
    /// @param amount amount to burn on destination (to unlock on source)
    function burnTokens(
        uint256 destChainId,
        address recipient,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress("recipient");
        if (totalMintedSupply < amount)
            revert InsufficientMintedSupply(totalMintedSupply, amount);

        address destTokenAddress = allowedSourceTokens[destChainId];
        if (destTokenAddress == address(0))
            revert BurnForDestinationChainNotAllowed(destChainId);

        // transfer tokens to this contract to initiate burn (only minter allowed to burn)
        bridgedToken.safeTransferFrom(msg.sender, address(this), amount);

        // burn bridged tokens
        bridgedToken.burn(amount);

        nonce += 1;
        totalMintedSupply -= amount;

        BurnRecord memory burnRecord = BurnRecord(
            msg.sender,
            recipient,
            amount,
            address(bridgedToken),
            destChainId,
            destTokenAddress,
            block.timestamp + maxConfirmationPeriod,
            nonce
        );
        bytes32 burnId = _getBurnId(burnRecord);
        burnRecords[burnId] = burnRecord;

        emit TokensBurned(
            burnId,
            msg.sender,
            recipient,
            amount,
            address(bridgedToken),
            block.timestamp + maxConfirmationPeriod,
            destChainId,
            destTokenAddress
        );
    }

    /// @notice Confirm burn on destination chain. Only callable by authorized message adapter.
    function confirmBurn(
        bytes32 burnId,
        bytes32 receipt,
        uint256 destChainId,
        address destTokenAddress
    ) external nonReentrant whenNotPaused onlyRole(MESSAGE_ADAPTER_ROLE) {
        BurnRecord memory burnRecord = burnRecords[burnId];
        if (burnRecord.sender == address(0)) revert InvalidId();
        if (destChainId != burnRecord.destChainId)
            revert DestinationChainNotAllowed(
                burnRecord.destChainId,
                destChainId
            );
        if (destTokenAddress != burnRecord.destTokenAddress)
            revert DestinationTokenNotAllowed(
                burnRecord.destTokenAddress,
                destTokenAddress
            );
        if (isBurnReverted[burnId]) revert ConfirmBurnNotAllowed(burnId);
        if (confirmedBurnReceipts[burnId] != bytes32(0))
            revert AlreadyProcessed();

        confirmedBurnReceipts[burnId] = receipt;

        // Delete a burn record
        delete burnRecords[burnId];

        emit BurnConfirmed(burnId, receipt);
    }

    /// @notice Revert tokens burned on destination chain. Only callable by authorized message adapter.
    function revertBurnedTokens(
        bytes32 burnId
    ) external nonReentrant whenNotPaused onlyRole(MESSAGE_ADAPTER_ROLE) {
        BurnRecord memory burnRecord = burnRecords[burnId];
        if (burnRecord.sender == address(0)) revert InvalidId();
        if (block.timestamp < burnRecord.maxConfirmationTimestamp)
            revert RevertBurnedTokensTooEarly(
                block.timestamp,
                burnRecord.maxConfirmationTimestamp
            );
        if (confirmedBurnReceipts[burnId] != bytes32(0))
            revert RevertNotAllowed(burnId);
        if (isBurnReverted[burnId]) revert AlreadyProcessed();

        isBurnReverted[burnId] = true;
        totalMintedSupply += burnRecord.amount;

        // mint bridged tokens
        bool minted = bridgedToken.mint(burnRecord.sender, burnRecord.amount);
        if (!minted)
            revert MintTokensFailed(burnRecord.sender, burnRecord.amount);

        // Delete a burn record
        delete burnRecords[burnId];

        emit RevertedBurnedTokens(burnId, burnRecord.sender, burnRecord.amount);
    }

    /// @notice Mint bridged tokens on destination chain. Only callable by authorized message adapter.
    /// @dev Adapter will pass canonical payload including srcChainId and srcTxHash for replay-protection.
    function mintTokens(
        bytes32 lockId,
        uint256 srcChainId,
        address srcTokenAddress,
        address sender,
        address recipient,
        uint256 amount,
        uint256 maxConfirmationTimestamp
    ) external whenNotPaused nonReentrant onlyRole(MESSAGE_ADAPTER_ROLE) {
        if (srcChainId == 0) revert InvalidChainId("srcChainId");
        if (lockId == bytes32(0)) revert InvalidId();
        if (recipient == address(0)) revert ZeroAddress("recipient");
        if (amount == 0) revert InvalidAmount();
        if (maxConfirmationTimestamp < block.timestamp)
            revert RequestTimeout(block.timestamp, maxConfirmationTimestamp);
        if (processedMints[lockId]) revert AlreadyProcessed();

        address allowedSrcTokenAddress = allowedSourceTokens[srcChainId];
        if (allowedSrcTokenAddress == address(0))
            revert MintNotAllowedFromSource(srcChainId);
        if (srcTokenAddress != allowedSrcTokenAddress)
            revert MintNotAllowedFromSourceToken(
                allowedSrcTokenAddress,
                srcTokenAddress
            );

        processedMints[lockId] = true;
        totalMintedSupply += amount;

        // mint bridged tokens
        bool minted = bridgedToken.mint(recipient, amount);
        if (!minted) revert MintTokensFailed(recipient, amount);

        emit TokensMinted(
            lockId,
            sender,
            recipient,
            amount,
            address(bridgedToken),
            srcChainId,
            srcTokenAddress
        );
    }

    // storage gap
    uint256[50] private __gap;
}
