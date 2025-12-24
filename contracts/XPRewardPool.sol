// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title XPRewardPool
 * @notice Native-METIS reward pool per period with EIP-712 signed claims.
 *
 * Period IDs are computed from a versioned schedule of {startTimestamp, durationSeconds}.
 * The schedule supports changing duration without renumbering past periods by using a
 * cumulative period offset.
 */
contract XPRewardPool is Ownable, EIP712 {
  using ECDSA for bytes32;

  // -------------------------
  // Errors
  // -------------------------
  error InvalidDuration();
  error InvalidStartTimestamp();
  error NoPeriodConfigs();
  error PeriodConfigNotAligned();
  error PoolAlreadyExists(uint256 periodId);
  error PoolDoesNotExist(uint256 periodId);
  error DistributionLengthMismatch();
  error DistributionAlreadySet(uint256 periodId);
  error DuplicateRank(uint256 rank);
  error DistributionExceedsPool(uint256 totalDistributed, uint256 poolTotal);
  error RewardNotConfigured(uint256 periodId, uint256 rank);
  error InvalidRewardAmount(uint256 expected, uint256 provided);
  error AlreadyClaimed(uint256 periodId, address user);
  error InvalidNonce(uint256 expected, uint256 provided);
  error InvalidSignature();
  error InsufficientPoolFunds(uint256 available, uint256 required);

  // -------------------------
  // EIP-712
  // -------------------------
  bytes32 private constant CLAIM_TYPEHASH =
    keccak256("Claim(uint256 periodId,address user,uint256 rank,uint256 rewardAmount,uint256 nonce)");

  address public signer;

  // -------------------------
  // Period config (versioned)
  // -------------------------
  struct PeriodConfig {
    uint64 startTimestamp; // inclusive
    uint64 durationSeconds; // > 0
    uint128 cumulativePeriodOffset; // number of periods before this config starts
  }

  PeriodConfig[] private _configs;

  // -------------------------
  // Pools & distribution
  // -------------------------
  struct Pool {
    bool exists;
    uint256 totalAmount; // configured total amount (for validation)
    uint256 fundedAmount; // actual deposited amount (native)
  }

  mapping(uint256 periodId => Pool) public pools;
  mapping(uint256 periodId => mapping(uint256 rank => uint256 amount)) private _rewardsByRank;
  mapping(uint256 periodId => bool) private _distributionSet;

  // -------------------------
  // Claim tracking
  // -------------------------
  mapping(uint256 periodId => mapping(address user => bool)) private _claimed;
  mapping(address user => mapping(uint256 periodId => uint256 nonce)) private _nonces;

  // -------------------------
  // Events
  // -------------------------
  event SignerUpdated(address indexed oldSigner, address indexed newSigner);
  event PeriodConfigAdded(uint256 indexed index, uint64 startTimestamp, uint64 durationSeconds, uint128 cumulativePeriodOffset);
  event PoolCreated(uint256 indexed periodId, uint256 totalAmount);
  event PoolFunded(uint256 indexed periodId, address indexed funder, uint256 amount);
  event RewardDistributionSet(uint256 indexed periodId);
  event RewardClaimed(uint256 indexed periodId, address indexed user, uint256 rank, uint256 amount);

  constructor(address initialOwner, address initialSigner)
    Ownable(initialOwner)
    EIP712("XPRewardPool", "1")
  {
    signer = initialSigner;
    emit SignerUpdated(address(0), initialSigner);
  }

  // -------------------------
  // Admin
  // -------------------------
  function setSigner(address newSigner) external onlyOwner {
    address old = signer;
    signer = newSigner;
    emit SignerUpdated(old, newSigner);
  }

  /**
   * @notice Add a new period config effective from `startTimestamp` (inclusive).
   * Requirements:
   * - durationSeconds > 0
   * - startTimestamp must be strictly increasing vs last config
   */
  function addPeriodConfig(uint64 startTimestamp, uint64 durationSeconds) external onlyOwner {
    if (durationSeconds == 0) revert InvalidDuration();
    uint256 len = _configs.length;
    if (len == 0) {
      _configs.push(PeriodConfig({
        startTimestamp: startTimestamp,
        durationSeconds: durationSeconds,
        cumulativePeriodOffset: 0
      }));
      emit PeriodConfigAdded(0, startTimestamp, durationSeconds, 0);
      return;
    }

    PeriodConfig memory prev = _configs[len - 1];
    if (startTimestamp <= prev.startTimestamp) revert InvalidStartTimestamp();

    // Compute how many periods fit into [prev.start, startTimestamp)
    uint256 delta = uint256(startTimestamp) - uint256(prev.startTimestamp);
    // Require alignment to avoid "partial period" ambiguity between configs.
    if (delta % uint256(prev.durationSeconds) != 0) revert PeriodConfigNotAligned();
    uint256 periodsInPrev = delta / uint256(prev.durationSeconds);
    uint128 newOffset = prev.cumulativePeriodOffset + uint128(periodsInPrev);

    _configs.push(PeriodConfig({
      startTimestamp: startTimestamp,
      durationSeconds: durationSeconds,
      cumulativePeriodOffset: newOffset
    }));
    emit PeriodConfigAdded(len, startTimestamp, durationSeconds, newOffset);
  }

  function getPeriodConfigsCount() external view returns (uint256) {
    return _configs.length;
  }

  function getPeriodConfig(uint256 index) external view returns (uint64 startTimestamp, uint64 durationSeconds, uint128 cumulativePeriodOffset) {
    PeriodConfig memory c = _configs[index];
    return (c.startTimestamp, c.durationSeconds, c.cumulativePeriodOffset);
  }

  function createPool(uint256 periodId, uint256 totalAmount) external onlyOwner {
    if (pools[periodId].exists) revert PoolAlreadyExists(periodId);
    pools[periodId] = Pool({ exists: true, totalAmount: totalAmount, fundedAmount: 0 });
    emit PoolCreated(periodId, totalAmount);
  }

  function fundPool(uint256 periodId) external payable {
    Pool storage p = pools[periodId];
    if (!p.exists) revert PoolDoesNotExist(periodId);
    p.fundedAmount += msg.value;
    emit PoolFunded(periodId, msg.sender, msg.value);
  }

  function setRewardDistribution(uint256 periodId, uint256[] calldata ranks, uint256[] calldata amounts) external onlyOwner {
    Pool memory p = pools[periodId];
    if (!p.exists) revert PoolDoesNotExist(periodId);
    if (ranks.length != amounts.length) revert DistributionLengthMismatch();
    if (_distributionSet[periodId]) revert DistributionAlreadySet(periodId);

    // Basic validation: no duplicate ranks, and sum <= pool.totalAmount
    uint256 total;
    for (uint256 i = 0; i < ranks.length; i++) {
      uint256 r = ranks[i];
      for (uint256 j = 0; j < i; j++) {
        if (ranks[j] == r) revert DuplicateRank(r);
      }
      uint256 a = amounts[i];
      _rewardsByRank[periodId][r] = a;
      total += a;
    }
    if (total > p.totalAmount) revert DistributionExceedsPool(total, p.totalAmount);
    _distributionSet[periodId] = true;
    emit RewardDistributionSet(periodId);
  }

  // -------------------------
  // Views
  // -------------------------
  function poolExists(uint256 periodId) external view returns (bool) {
    return pools[periodId].exists;
  }

  function hasClaimed(uint256 periodId, address user) external view returns (bool) {
    return _claimed[periodId][user];
  }

  function nonces(address user, uint256 periodId) external view returns (uint256) {
    return _nonces[user][periodId];
  }

  function getReward(uint256 periodId, uint256 rank) external view returns (uint256) {
    return _rewardsByRank[periodId][rank];
  }

  function calculatePeriodId(uint256 timestamp) public view returns (uint256) {
    uint256 len = _configs.length;
    if (len == 0) revert NoPeriodConfigs();

    // Find last config with startTimestamp <= timestamp (linear scan; len expected small)
    uint256 idx = 0;
    for (uint256 i = 0; i < len; i++) {
      if (timestamp < uint256(_configs[i].startTimestamp)) break;
      idx = i;
    }

    PeriodConfig memory c = _configs[idx];
    if (timestamp < uint256(c.startTimestamp)) {
      // timestamp before first config
      revert InvalidStartTimestamp();
    }
    uint256 periodsSinceStart = (timestamp - uint256(c.startTimestamp)) / uint256(c.durationSeconds);
    return uint256(c.cumulativePeriodOffset) + periodsSinceStart;
  }

  function getCurrentPeriodId() external view returns (uint256) {
    return calculatePeriodId(block.timestamp);
  }

  // -------------------------
  // Claim
  // -------------------------
  function claimReward(
    uint256 periodId,
    uint256 rank,
    uint256 rewardAmount,
    uint256 nonce,
    bytes calldata signature
  ) external {
    Pool storage p = pools[periodId];
    if (!p.exists) revert PoolDoesNotExist(periodId);

    if (_claimed[periodId][msg.sender]) revert AlreadyClaimed(periodId, msg.sender);

    uint256 expectedReward = _rewardsByRank[periodId][rank];
    if (expectedReward == 0) revert RewardNotConfigured(periodId, rank);
    if (rewardAmount != expectedReward) revert InvalidRewardAmount(expectedReward, rewardAmount);

    uint256 expectedNonce = _nonces[msg.sender][periodId];
    if (nonce != expectedNonce) revert InvalidNonce(expectedNonce, nonce);

    bytes32 structHash = keccak256(
      abi.encode(CLAIM_TYPEHASH, periodId, msg.sender, rank, rewardAmount, nonce)
    );
    bytes32 digest = _hashTypedDataV4(structHash);
    address recovered = ECDSA.recover(digest, signature);
    if (recovered != signer) revert InvalidSignature();

    if (p.fundedAmount < rewardAmount) revert InsufficientPoolFunds(p.fundedAmount, rewardAmount);

    // Effects
    _claimed[periodId][msg.sender] = true;
    _nonces[msg.sender][periodId] = expectedNonce + 1;
    p.fundedAmount -= rewardAmount;

    // Interactions: native transfer
    (bool ok, ) = msg.sender.call{value: rewardAmount}("");
    require(ok, "NATIVE_TRANSFER_FAILED");

    emit RewardClaimed(periodId, msg.sender, rank, rewardAmount);
  }

  receive() external payable {
    revert("Use fundPool(periodId)");
  }
}


