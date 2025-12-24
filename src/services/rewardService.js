const { ethers } = require("ethers");
const { setupLogger } = require("../utils/logger");
const { Leaderboard, PeriodRewardSnapshot, RewardSnapshotState } = require("./xpService");
const { getWalletForUser, sendContractTransaction } = require("./privyUserService");

const logger = setupLogger();

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is not set`);
  return v;
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

class RewardService {
  constructor() {
    this.contractAddress = requiredEnv("REWARD_CONTRACT_ADDRESS");
    this.provider = new ethers.JsonRpcProvider(requiredEnv("ETH_RPC_URL"));

    // ABI is committed into x-pay/contracts as part of this rollout
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const abiFile = require("../../contracts/XPRewardPool.json");
    const abi = Array.isArray(abiFile) ? abiFile : abiFile.abi;
    if (!Array.isArray(abi)) throw new Error("XPRewardPool ABI file is invalid (expected ABI array or { abi: [...] })");

    this.contract = new ethers.Contract(this.contractAddress, abi, this.provider);

    const signerPk = requiredEnv("REWARD_SIGNER_PRIVATE_KEY");
    this.signerWallet = new ethers.Wallet(signerPk, this.provider);

    this.topN = toInt(requiredEnv("REWARD_TOP_N"), "REWARD_TOP_N");
    // NOTE: rewards distribution is derived from the on-chain contract per periodId/rank.

    this.snapshotCheckIntervalSeconds = toInt(requiredEnv("SNAPSHOT_CHECK_INTERVAL"), "SNAPSHOT_CHECK_INTERVAL");

    // cache
    this._configsCache = null;
    this._configsCacheAtMs = 0;
  }

  async getRewardWei(periodId, rank) {
    // Contract returns 0 if not configured.
    const amt = await this.contract.getReward(periodId, rank);
    const bi = typeof amt === "bigint" ? amt : BigInt(amt.toString());
    return bi.toString();
  }

  async getSnapshotStatus() {
    const stateKey = "xp_reward_pool";
    let state = await RewardSnapshotState.findOne({ key: stateKey }).lean();
    if (!state) {
      await RewardSnapshotState.create({ key: stateKey, lastSnapshottedPeriodId: -1 });
      state = { key: stateKey, lastSnapshottedPeriodId: -1 };
    }

    let currentPeriodId = null;
    try {
      currentPeriodId = await this.getCurrentPeriodId();
    } catch (e) {
      // If period configs aren't set, contract will revert; surface as "not ready"
      return {
        enabled: true,
        intervalSeconds: this.snapshotCheckIntervalSeconds,
        currentPeriodId: null,
        lastSnapshottedPeriodId: state.lastSnapshottedPeriodId ?? -1,
        lastCheckedAt: state.lastCheckedAt ?? null,
        nextCheckAt: state.nextCheckAt ?? null,
        needsSnapshot: false,
        pendingFromPeriodId: null,
        pendingToPeriodId: null,
        note: `Could not read currentPeriodId: ${e.message}`,
      };
    }

    const startPid = (state.lastSnapshottedPeriodId ?? -1) + 1;
    const endPid = currentPeriodId - 1;
    const needsSnapshot = startPid <= endPid;

    return {
      enabled: true,
      intervalSeconds: this.snapshotCheckIntervalSeconds,
      currentPeriodId,
      lastSnapshottedPeriodId: state.lastSnapshottedPeriodId ?? -1,
      lastCheckedAt: state.lastCheckedAt ?? null,
      nextCheckAt: state.nextCheckAt ?? null,
      needsSnapshot,
      pendingFromPeriodId: needsSnapshot ? startPid : null,
      pendingToPeriodId: needsSnapshot ? endPid : null,
      note: null,
    };
  }

  async getCurrentPeriodId() {
    const pid = await this.contract.getCurrentPeriodId();
    return Number(pid);
  }

  async poolExists(periodId) {
    return await this.contract.poolExists(periodId);
  }

  async hasClaimed(periodId, userAddress) {
    return await this.contract.hasClaimed(periodId, userAddress);
  }

  async getUserNonce(periodId, userAddress) {
    const n = await this.contract.nonces(userAddress, periodId);
    return BigInt(n);
  }

  async _getConfigsCached() {
    const now = Date.now();
    if (this._configsCache && now - this._configsCacheAtMs < 60_000) return this._configsCache;

    const count = Number(await this.contract.getPeriodConfigsCount());
    if (!count) throw new Error("No period configs set on contract");

    const configs = [];
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const c = await this.contract.getPeriodConfig(i);
      configs.push({
        startTimestamp: Number(c[0]),
        durationSeconds: Number(c[1]),
        offset: Number(c[2]),
      });
    }

    this._configsCache = configs;
    this._configsCacheAtMs = now;
    return configs;
  }

  _selectConfigForPeriod(periodId, configs) {
    // pick last config whose offset <= periodId
    let selected = configs[0];
    for (const c of configs) {
      if (c.offset <= periodId) selected = c;
    }
    return selected;
  }

  async getPeriodInfo(periodId) {
    const configs = await this._getConfigsCached();
    const { startTimestamp, durationSeconds, offset } = this._selectConfigForPeriod(periodId, configs);
    const periodStart = startTimestamp + (periodId - offset) * durationSeconds;
    const periodEnd = periodStart + durationSeconds;
    return {
      periodId,
      periodDuration: durationSeconds,
      periodStart: new Date(periodStart * 1000),
      periodEnd: new Date(periodEnd * 1000),
    };
  }

  async snapshotLeaderboard(periodId) {
    const { periodDuration, periodStart, periodEnd } = await this.getPeriodInfo(periodId);

    // Query leaderboard deterministically. Tie-break: userId asc.
    const top = await Leaderboard.find({ totalXP: { $gt: 0 } })
      .sort({ totalXP: -1, userId: 1 })
      .limit(this.topN)
      .lean();

    if (!top || top.length === 0) {
      logger.info("No eligible users for snapshot", { periodId });
      return { periodId, created: 0 };
    }

    let created = 0;
    for (let i = 0; i < top.length; i++) {
      const row = top[i];
      const rank = i + 1;

      try {
        // eslint-disable-next-line no-await-in-loop
        await PeriodRewardSnapshot.updateOne(
          { periodId, userId: row.userId },
          {
            $setOnInsert: {
              periodId,
              periodDuration,
              periodStart,
              periodEnd,
              userId: row.userId,
              username: row.username,
              rank,
              totalXP: row.totalXP,
              // Placeholder; actual reward is derived from contract at claim-time
              rewardAmount: "0",
              tokenAddress: ethers.ZeroAddress,
              claimed: false,
              snapshotDate: new Date(),
            },
          },
          { upsert: true }
        );
        created += 1;
      } catch (e) {
        // duplicate is fine (already snapshotted)
        logger.warn("Snapshot upsert failed", { periodId, userId: row.userId, error: e.message });
      }
    }

    return { periodId, created };
  }

  async snapshotIfNeeded() {
    const current = await this.getCurrentPeriodId();
    if (!Number.isFinite(current) || current <= 0) return;

    const stateKey = "xp_reward_pool";
    let state = await RewardSnapshotState.findOne({ key: stateKey }).lean();
    if (!state) {
      await RewardSnapshotState.create({ key: stateKey, lastSnapshottedPeriodId: -1 });
      state = { key: stateKey, lastSnapshottedPeriodId: -1 };
    }

    // Track schedule visibility for admin UI.
    const now = new Date();
    const next = new Date(Date.now() + this.snapshotCheckIntervalSeconds * 1000);
    await RewardSnapshotState.updateOne(
      { key: stateKey },
      { $set: { lastCheckedAt: now, nextCheckAt: next, updatedAt: new Date() } }
    );

    const startPid = (state.lastSnapshottedPeriodId ?? -1) + 1;
    const endPid = current - 1;
    if (startPid > endPid) return;

    logger.info("Reward snapshot catch-up", { startPid, endPid, currentPeriodId: current });

    const processed = [];
    for (let pid = startPid; pid <= endPid; pid++) {
      // For pid < current, this should be ended by definition, but keep the safety check.
      // eslint-disable-next-line no-await-in-loop
      const info = await this.getPeriodInfo(pid);
      if (info.periodEnd.getTime() > Date.now()) break;

      // eslint-disable-next-line no-await-in-loop
      const res = await this.snapshotLeaderboard(pid);
      processed.push(res);

      // advance state even if snapshot has 0 eligible users (so we don't rescan forever)
      // eslint-disable-next-line no-await-in-loop
      await RewardSnapshotState.updateOne(
        { key: stateKey },
        { $set: { lastSnapshottedPeriodId: pid, updatedAt: new Date() } }
      );
    }

    return { currentPeriodId: current, startPid, endPid, processed };
  }

  async getClaimableRewards(twitterUserId) {
    const wallet = await getWalletForUser(twitterUserId);
    if (!wallet || !wallet.address) return [];

    const rows = await PeriodRewardSnapshot.find({ userId: twitterUserId, claimed: false })
      .sort({ periodId: -1 })
      .lean();

    const claimable = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await this.poolExists(r.periodId);
      if (!exists) continue;
      // eslint-disable-next-line no-await-in-loop
      const already = await this.hasClaimed(r.periodId, wallet.address);
      if (already) continue;
      // eslint-disable-next-line no-await-in-loop
      const rewardWei = await this.getRewardWei(r.periodId, r.rank);
      if (!rewardWei || rewardWei === "0") continue; // distribution not set or no reward for this rank

      // best-effort cache for later reads
      // eslint-disable-next-line no-await-in-loop
      await PeriodRewardSnapshot.updateOne(
        { periodId: r.periodId, userId: twitterUserId },
        { $set: { rewardAmount: rewardWei } }
      );

      claimable.push({ ...r, rewardAmount: rewardWei });
    }
    return claimable;
  }

  async generateClaimSignature(periodId, userAddress, rank, rewardAmountWei, nonce) {
    const network = await this.provider.getNetwork();
    const domain = {
      name: "XPRewardPool",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: this.contractAddress,
    };
    const types = {
      Claim: [
        { name: "periodId", type: "uint256" },
        { name: "user", type: "address" },
        { name: "rank", type: "uint256" },
        { name: "rewardAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };
    const value = {
      periodId,
      user: userAddress,
      rank,
      rewardAmount: rewardAmountWei,
      nonce,
    };
    return await this.signerWallet.signTypedData(domain, types, value);
  }

  async claim(periodId, twitterUserId) {
    const wallet = await getWalletForUser(twitterUserId);
    if (!wallet || !wallet.id || !wallet.address) throw new Error("Please create a wallet first using 'create wallet'.");

    const snapshot = await PeriodRewardSnapshot.findOne({ periodId, userId: twitterUserId }).lean();
    if (!snapshot) throw new Error(`No snapshot reward found for period ${periodId}. You may not have been in the top ${this.topN}.`);
    if (snapshot.claimed) throw new Error(`You already claimed rewards for period ${periodId}.`);

    const exists = await this.poolExists(periodId);
    if (!exists) throw new Error(`No reward pool available for period ${periodId}.`);

    const already = await this.hasClaimed(periodId, wallet.address);
    if (already) {
      await PeriodRewardSnapshot.updateOne(
        { periodId, userId: twitterUserId },
        { $set: { claimed: true, claimedAt: new Date() } }
      );
      throw new Error(`You already claimed rewards for period ${periodId}.`);
    }

    const rewardWei = await this.getRewardWei(periodId, snapshot.rank);
    if (!rewardWei || rewardWei === "0") {
      throw new Error(`Reward is not configured for period ${periodId} rank #${snapshot.rank} yet.`);
    }

    const nonce = await this.getUserNonce(periodId, wallet.address);
    const sig = await this.generateClaimSignature(
      periodId,
      wallet.address,
      snapshot.rank,
      rewardWei,
      nonce
    );

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const abiFile2 = require("../../contracts/XPRewardPool.json");
    const abi2 = Array.isArray(abiFile2) ? abiFile2 : abiFile2.abi;
    const iface = new ethers.Interface(abi2);
    const data = iface.encodeFunctionData("claimReward", [
      periodId,
      snapshot.rank,
      rewardWei,
      nonce,
      sig,
    ]);

    const tx = await sendContractTransaction(wallet.id, {
      to: this.contractAddress,
      data,
      value: "0",
    });

    await PeriodRewardSnapshot.updateOne(
      { periodId, userId: twitterUserId },
      { $set: { claimed: true, claimedAt: new Date(), txHash: tx.hash, rewardAmount: rewardWei } }
    );

    return { txHash: tx.hash };
  }
}

module.exports = { RewardService };

// Lazy singleton: do not crash process if rewards aren't configured.
let _singleton = null;
let _singletonError = null;
function getRewardService() {
  if (_singleton) return _singleton;
  if (_singletonError) return null;
  try {
    _singleton = new RewardService();
    return _singleton;
  } catch (e) {
    _singletonError = e;
    logger.warn("RewardService disabled (missing/invalid env)", { error: e.message });
    return null;
  }
}

module.exports.getRewardService = getRewardService;

function getRewardServiceInitError() {
  return _singletonError ? _singletonError.message : null;
}

module.exports.getRewardServiceInitError = getRewardServiceInitError;


