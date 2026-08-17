import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { OnestableSourceBridge, MockERC20 } from "../typechain-types";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionResponse } from "ethers";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEST_CHAIN_ID = 56n; // BSC – must differ from Hardhat default (31337)
const DEST_TOKEN = "0x000000000000000000000000000000000000dEaD";
const MAX_CONF_PERIOD = 3600; // 1 hour
const INITIAL_MINT = ethers.parseEther("1000000");
const FEE_DENOMINATOR = 100_000n;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function deployBridge(
  tokenAddr: string,
  destChainId: bigint,
  destToken: string,
  period: number,
  adminAddr: string,
  pauserAddr: string,
  upgraderAddr: string
): Promise<OnestableSourceBridge> {
  const Impl = await ethers.getContractFactory("OnestableSourceBridge");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    tokenAddr,
    destChainId,
    destToken,
    period,
    adminAddr,
    pauserAddr,
    upgraderAddr,
  ]);

  const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  return Impl.attach(await proxy.getAddress()) as OnestableSourceBridge;
}

async function extractLockId(
  bridge: OnestableSourceBridge,
  tx: ContractTransactionResponse
): Promise<string> {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = bridge.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed?.name === "TokensLocked") return parsed.args[0] as string;
    } catch {}
  }
  throw new Error("TokensLocked event not found in receipt");
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("OnestableSourceBridge", function () {
  let bridge: OnestableSourceBridge;
  let token: MockERC20;
  let admin: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let upgrader: HardhatEthersSigner;
  let adapter: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let bridgeAddress: string;
  let tokenAddress: string;

  beforeEach(async () => {
    [admin, pauser, upgrader, adapter, user1, user2, stranger] =
      await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    token = (await MockERC20Factory.deploy("Mock USDC", "mUSDC")) as MockERC20;
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    await token.mint(user1.address, INITIAL_MINT);
    await token.mint(user2.address, INITIAL_MINT);

    bridge = await deployBridge(
      tokenAddress,
      DEST_CHAIN_ID,
      DEST_TOKEN,
      MAX_CONF_PERIOD,
      admin.address,
      pauser.address,
      upgrader.address
    );
    bridgeAddress = await bridge.getAddress();

    // Grant MESSAGE_ADAPTER_ROLE to adapter
    await bridge.connect(admin).setMessageAdapter(adapter.address, true);

    // Approve bridge to spend user tokens
    await token.connect(user1).approve(bridgeAddress, ethers.MaxUint256);
    await token.connect(user2).approve(bridgeAddress, ethers.MaxUint256);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // initialize
  // ───────────────────────────────────────────────────────────────────────────
  describe("initialize", function () {
    it("sets token, destChainId, destTokenAddress, maxConfirmationPeriod", async () => {
      expect(await bridge.token()).to.equal(tokenAddress);
      expect(await bridge.destChainId()).to.equal(DEST_CHAIN_ID);
      expect(await bridge.destTokenAddress()).to.equal(DEST_TOKEN);
      expect(await bridge.maxConfirmationPeriod()).to.equal(MAX_CONF_PERIOD);
    });

    it("grants DEFAULT_ADMIN_ROLE, PAUSER_ROLE, UPGRADER_ROLE to correct addresses", async () => {
      expect(
        await bridge.hasRole(await bridge.DEFAULT_ADMIN_ROLE(), admin.address)
      ).to.be.true;
      expect(
        await bridge.hasRole(await bridge.PAUSER_ROLE(), pauser.address)
      ).to.be.true;
      expect(
        await bridge.hasRole(await bridge.UPGRADER_ROLE(), upgrader.address)
      ).to.be.true;
    });

    it("initialises fee state to zero (no fees, no cap, no minimum)", async () => {
      expect(await bridge.feeRate()).to.equal(0n);
      expect(await bridge.maxFeeAmount()).to.equal(0n);
      expect(await bridge.minBridgeAmount()).to.equal(0n);
      expect(await bridge.collectedFees()).to.equal(0n);
    });

    it("reverts on zero token address", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        DEST_CHAIN_ID,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        admin.address,
        pauser.address,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      ).to.be.revertedWithCustomError(impl, "ZeroAddress").withArgs("_token");
    });

    it("reverts when destChainId equals the current chain", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const { chainId } = await ethers.provider.getNetwork();
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        chainId,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        admin.address,
        pauser.address,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      ).to.be.revertedWithCustomError(impl, "InvalidChainId");
    });

    it("reverts when destChainId is zero", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        0n,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        admin.address,
        pauser.address,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      ).to.be.revertedWithCustomError(impl, "InvalidChainId");
    });

    it("reverts on zero destTokenAddress", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        DEST_CHAIN_ID,
        ethers.ZeroAddress,
        MAX_CONF_PERIOD,
        admin.address,
        pauser.address,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      )
        .to.be.revertedWithCustomError(impl, "ZeroAddress")
        .withArgs("_destTokenAddress");
    });

    it("reverts on zero defaultAdmin", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        DEST_CHAIN_ID,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        ethers.ZeroAddress,
        pauser.address,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      )
        .to.be.revertedWithCustomError(impl, "ZeroAddress")
        .withArgs("_defaultAdmin");
    });

    it("reverts on zero pauser", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        DEST_CHAIN_ID,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        admin.address,
        ethers.ZeroAddress,
        upgrader.address,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      )
        .to.be.revertedWithCustomError(impl, "ZeroAddress")
        .withArgs("_pauser");
    });

    it("reverts on zero upgrader", async () => {
      const Impl = await ethers.getContractFactory("OnestableSourceBridge");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("OnestableSourceBridgeProxy");
      const data = impl.interface.encodeFunctionData("initialize", [
        tokenAddress,
        DEST_CHAIN_ID,
        DEST_TOKEN,
        MAX_CONF_PERIOD,
        admin.address,
        pauser.address,
        ethers.ZeroAddress,
      ]);
      await expect(
        Proxy.deploy(await impl.getAddress(), data)
      )
        .to.be.revertedWithCustomError(impl, "ZeroAddress")
        .withArgs("_upgrader");
    });

    it("cannot be re-initialized", async () => {
      await expect(
        bridge.initialize(
          tokenAddress,
          DEST_CHAIN_ID,
          DEST_TOKEN,
          MAX_CONF_PERIOD,
          admin.address,
          pauser.address,
          upgrader.address
        )
      ).to.be.revertedWithCustomError(bridge, "InvalidInitialization");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // setFeeRate
  // ───────────────────────────────────────────────────────────────────────────
  describe("setFeeRate", function () {
    it("admin sets a valid fee rate", async () => {
      await bridge.connect(admin).setFeeRate(1000n);
      expect(await bridge.feeRate()).to.equal(1000n);
    });

    it("emits FeeRateUpdated", async () => {
      await expect(bridge.connect(admin).setFeeRate(500n))
        .to.emit(bridge, "FeeRateUpdated")
        .withArgs(500n);
    });

    it("allows feeRate = 0 (disables fees)", async () => {
      await bridge.connect(admin).setFeeRate(1000n);
      await bridge.connect(admin).setFeeRate(0n);
      expect(await bridge.feeRate()).to.equal(0n);
    });

    it("allows feeRate = MAX_FEE_RATE (10%)", async () => {
      await bridge.connect(admin).setFeeRate(10_000n);
      expect(await bridge.feeRate()).to.equal(10_000n);
    });

    it("reverts when feeRate exceeds MAX_FEE_RATE", async () => {
      await expect(bridge.connect(admin).setFeeRate(10_001n))
        .to.be.revertedWithCustomError(bridge, "InvalidFeeRate")
        .withArgs(10_001n, 10_000n);
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).setFeeRate(500n)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // setMaxFeeAmount
  // ───────────────────────────────────────────────────────────────────────────
  describe("setMaxFeeAmount", function () {
    it("admin sets a non-zero cap", async () => {
      const cap = ethers.parseEther("10");
      await bridge.connect(admin).setMaxFeeAmount(cap);
      expect(await bridge.maxFeeAmount()).to.equal(cap);
    });

    it("emits MaxFeeAmountUpdated", async () => {
      await expect(bridge.connect(admin).setMaxFeeAmount(100n))
        .to.emit(bridge, "MaxFeeAmountUpdated")
        .withArgs(100n);
    });

    it("allows setting to 0 (removes cap)", async () => {
      await bridge.connect(admin).setMaxFeeAmount(100n);
      await bridge.connect(admin).setMaxFeeAmount(0n);
      expect(await bridge.maxFeeAmount()).to.equal(0n);
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).setMaxFeeAmount(100n)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // setMinBridgeAmount
  // ───────────────────────────────────────────────────────────────────────────
  describe("setMinBridgeAmount", function () {
    it("admin sets a minimum", async () => {
      const min = ethers.parseEther("100");
      await bridge.connect(admin).setMinBridgeAmount(min);
      expect(await bridge.minBridgeAmount()).to.equal(min);
    });

    it("emits MinBridgeAmountUpdated", async () => {
      await expect(bridge.connect(admin).setMinBridgeAmount(50n))
        .to.emit(bridge, "MinBridgeAmountUpdated")
        .withArgs(50n);
    });

    it("allows setting to 0 (removes minimum)", async () => {
      await bridge.connect(admin).setMinBridgeAmount(1000n);
      await bridge.connect(admin).setMinBridgeAmount(0n);
      expect(await bridge.minBridgeAmount()).to.equal(0n);
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).setMinBridgeAmount(100n)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // lockTokens
  // ───────────────────────────────────────────────────────────────────────────
  describe("lockTokens", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");

    // ── no fee ──────────────────────────────────────────────────────────────
    describe("without fee (feeRate = 0)", function () {
      it("transfers gross amount to the contract", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await token.balanceOf(bridgeAddress)).to.equal(LOCK_AMOUNT);
      });

      it("totalLockedSupply increases by full amount", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.totalLockedSupply()).to.equal(LOCK_AMOUNT);
      });

      it("collectedFees stays zero", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(0n);
      });

      it("lock record stores full amount with zero feeAmount", async () => {
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const lockId = await extractLockId(bridge, tx);
        const record = await bridge.lockRecords(lockId);
        expect(record.sender).to.equal(user1.address);
        expect(record.recipient).to.equal(user2.address);
        expect(record.amount).to.equal(LOCK_AMOUNT);
        expect(record.feeAmount).to.equal(0n);
        expect(record.token).to.equal(tokenAddress);
        expect(record.destChainId).to.equal(DEST_CHAIN_ID);
        expect(record.destTokenAddress).to.equal(DEST_TOKEN);
      });

      it("emits TokensLocked with feeAmount = 0", async () => {
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const lockId = await extractLockId(bridge, tx);
        await expect(tx)
          .to.emit(bridge, "TokensLocked")
          .withArgs(
            lockId,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            0n,
            tokenAddress,
            anyValue,
            DEST_CHAIN_ID,
            DEST_TOKEN
          );
      });

      it("verifyParity is true after lock", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.verifyParity()).to.be.true;
      });

      it("sequential locks use distinct nonces (different lockIds)", async () => {
        const tx1 = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const tx2 = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const id1 = await extractLockId(bridge, tx1);
        const id2 = await extractLockId(bridge, tx2);
        expect(id1).to.not.equal(id2);
      });
    });

    // ── with fee ─────────────────────────────────────────────────────────────
    describe("with 1% fee (feeRate = 1000)", function () {
      const FEE_RATE = 1000n;

      beforeEach(async () => {
        await bridge.connect(admin).setFeeRate(FEE_RATE);
      });

      it("transfers gross amount from caller to contract", async () => {
        const balBefore = await token.balanceOf(user1.address);
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await token.balanceOf(user1.address)).to.equal(
          balBefore - LOCK_AMOUNT
        );
        expect(await token.balanceOf(bridgeAddress)).to.equal(LOCK_AMOUNT);
      });

      it("totalLockedSupply increases by netAmount only", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        const expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        expect(await bridge.totalLockedSupply()).to.equal(
          LOCK_AMOUNT - expectedFee
        );
      });

      it("collectedFees increases by feeAmount", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        const expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        expect(await bridge.collectedFees()).to.equal(expectedFee);
      });

      it("lock record stores netAmount and feeAmount correctly", async () => {
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const lockId = await extractLockId(bridge, tx);
        const record = await bridge.lockRecords(lockId);
        const expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        expect(record.amount).to.equal(LOCK_AMOUNT - expectedFee);
        expect(record.feeAmount).to.equal(expectedFee);
      });

      it("emits TokensLocked with netAmount and correct feeAmount", async () => {
        const expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        const expectedNet = LOCK_AMOUNT - expectedFee;
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        const lockId = await extractLockId(bridge, tx);
        await expect(tx)
          .to.emit(bridge, "TokensLocked")
          .withArgs(
            lockId,
            user1.address,
            user2.address,
            expectedNet,
            expectedFee,
            tokenAddress,
            anyValue,
            DEST_CHAIN_ID,
            DEST_TOKEN
          );
      });

      it("verifyParity is true after fee-bearing lock", async () => {
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.verifyParity()).to.be.true;
      });
    });

    // ── maxFeeAmount cap ──────────────────────────────────────────────────────
    describe("with maxFeeAmount cap", function () {
      it("caps fee when calculated fee > maxFeeAmount", async () => {
        await bridge.connect(admin).setFeeRate(1000n); // 1% → 10 ether on 1000
        const cap = ethers.parseEther("5");
        await bridge.connect(admin).setMaxFeeAmount(cap);

        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(cap);
        expect(await bridge.totalLockedSupply()).to.equal(LOCK_AMOUNT - cap);
      });

      it("does not cap fee when calculated fee <= maxFeeAmount", async () => {
        await bridge.connect(admin).setFeeRate(1000n); // 1% → 10 ether
        const cap = ethers.parseEther("50"); // well above 10
        await bridge.connect(admin).setMaxFeeAmount(cap);

        const expectedFee = (LOCK_AMOUNT * 1000n) / FEE_DENOMINATOR;
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(expectedFee);
      });

      it("no cap when maxFeeAmount = 0", async () => {
        await bridge.connect(admin).setFeeRate(1000n);
        // maxFeeAmount stays 0 → no cap
        const expectedFee = (LOCK_AMOUNT * 1000n) / FEE_DENOMINATOR;
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(expectedFee);
      });
    });

    // ── fee precision ─────────────────────────────────────────────────────────
    describe("fee precision (3 decimal places)", function () {
      it("0.001% (feeRate=1) on 1,000,000 tokens → fee = 10", async () => {
        await bridge.connect(admin).setFeeRate(1n);
        const amount = ethers.parseEther("1000000");
        await token.mint(user1.address, amount);
        await bridge.connect(user1).lockTokens(user2.address, amount);
        // 1_000_000 × 1 / 100_000 = 10
        expect(await bridge.collectedFees()).to.equal(ethers.parseEther("10"));
      });

      it("0.5% (feeRate=500) on 1,000 tokens → fee = 5", async () => {
        await bridge.connect(admin).setFeeRate(500n);
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(ethers.parseEther("5"));
      });

      it("1% (feeRate=1000) on 1,000 tokens → fee = 10", async () => {
        await bridge.connect(admin).setFeeRate(1000n);
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(ethers.parseEther("10"));
      });

      it("10% (feeRate=10000) on 1,000 tokens → fee = 100", async () => {
        await bridge.connect(admin).setFeeRate(10_000n);
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        expect(await bridge.collectedFees()).to.equal(
          ethers.parseEther("100")
        );
      });
    });

    // ── minBridgeAmount ───────────────────────────────────────────────────────
    describe("minBridgeAmount", function () {
      const MIN = ethers.parseEther("500");

      beforeEach(async () => {
        await bridge.connect(admin).setMinBridgeAmount(MIN);
      });

      it("reverts when amount < minBridgeAmount", async () => {
        await expect(
          bridge
            .connect(user1)
            .lockTokens(user2.address, ethers.parseEther("499"))
        )
          .to.be.revertedWithCustomError(bridge, "AmountBelowMinimum")
          .withArgs(ethers.parseEther("499"), MIN);
      });

      it("succeeds when amount = minBridgeAmount (boundary)", async () => {
        await expect(bridge.connect(user1).lockTokens(user2.address, MIN)).to
          .not.be.reverted;
      });

      it("succeeds when amount > minBridgeAmount", async () => {
        await expect(
          bridge
            .connect(user1)
            .lockTokens(user2.address, ethers.parseEther("501"))
        ).to.not.be.reverted;
      });

      it("no minimum check when minBridgeAmount = 0", async () => {
        await bridge.connect(admin).setMinBridgeAmount(0n);
        await expect(bridge.connect(user1).lockTokens(user2.address, 1n)).to
          .not.be.reverted;
      });
    });

    // ── input validation ──────────────────────────────────────────────────────
    describe("input validation", function () {
      it("reverts on zero amount", async () => {
        await expect(
          bridge.connect(user1).lockTokens(user2.address, 0n)
        ).to.be.revertedWithCustomError(bridge, "InvalidAmount");
      });

      it("reverts on zero recipient", async () => {
        await expect(
          bridge.connect(user1).lockTokens(ethers.ZeroAddress, LOCK_AMOUNT)
        )
          .to.be.revertedWithCustomError(bridge, "ZeroAddress")
          .withArgs("recipient");
      });

      it("reverts when paused", async () => {
        await bridge.connect(pauser).pause();
        await expect(
          bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT)
        ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // confirmLock
  // ───────────────────────────────────────────────────────────────────────────
  describe("confirmLock", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");
    const RECEIPT = ethers.keccak256(ethers.toUtf8Bytes("dest-tx-hash"));
    let lockId: string;

    beforeEach(async () => {
      const tx = await bridge
        .connect(user1)
        .lockTokens(user2.address, LOCK_AMOUNT);
      lockId = await extractLockId(bridge, tx);
    });

    it("adapter confirms a valid lock and stores receipt", async () => {
      await bridge
        .connect(adapter)
        .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN);
      expect(await bridge.confirmedLockReceipts(lockId)).to.equal(RECEIPT);
    });

    it("emits LockConfirmed", async () => {
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      )
        .to.emit(bridge, "LockConfirmed")
        .withArgs(lockId, RECEIPT);
    });

    it("deletes lock record after confirmation", async () => {
      await bridge
        .connect(adapter)
        .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN);
      const record = await bridge.lockRecords(lockId);
      expect(record.sender).to.equal(ethers.ZeroAddress);
    });

    it("reverts on unknown lockId", async () => {
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(ethers.ZeroHash, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      ).to.be.revertedWithCustomError(bridge, "InvalidId");
    });

    it("reverts with wrong destChainId", async () => {
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, 137n, DEST_TOKEN)
      ).to.be.revertedWithCustomError(bridge, "DestinationChainNotAllowed");
    });

    it("reverts with wrong destTokenAddress", async () => {
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bridge, "DestinationTokenNotAllowed");
    });

    it("reverts if lock was already reverted", async () => {
      await time.increase(MAX_CONF_PERIOD + 1);
      await bridge.connect(adapter).revertLockedTokens(lockId);
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      ).to.be.revertedWithCustomError(bridge, "ConfirmLockNotAllowed");
    });

    it("reverts if already confirmed (replay protection)", async () => {
      await bridge
        .connect(adapter)
        .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN);
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      ).to.be.revertedWithCustomError(bridge, "AlreadyProcessed");
    });

    it("reverts if called by non-adapter", async () => {
      await expect(
        bridge
          .connect(stranger)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts when paused", async () => {
      await bridge.connect(pauser).pause();
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // revertLockedTokens
  // ───────────────────────────────────────────────────────────────────────────
  describe("revertLockedTokens", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");

    // ── no fee ────────────────────────────────────────────────────────────────
    describe("without fee", function () {
      let lockId: string;

      beforeEach(async () => {
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        lockId = await extractLockId(bridge, tx);
      });

      it("refunds full amount to original sender after timeout", async () => {
        const balBefore = await token.balanceOf(user1.address);
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await token.balanceOf(user1.address)).to.equal(
          balBefore + LOCK_AMOUNT
        );
      });

      it("totalLockedSupply returns to 0", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.totalLockedSupply()).to.equal(0n);
      });

      it("marks lockId as reverted", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.isLockReverted(lockId)).to.be.true;
      });

      it("deletes the lock record", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        const record = await bridge.lockRecords(lockId);
        expect(record.sender).to.equal(ethers.ZeroAddress);
      });

      it("emits RevertedLockedTokens with full amount", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await expect(bridge.connect(adapter).revertLockedTokens(lockId))
          .to.emit(bridge, "RevertedLockedTokens")
          .withArgs(lockId, user1.address, LOCK_AMOUNT);
      });

      it("verifyParity is true after revert", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.verifyParity()).to.be.true;
      });

      it("reverts if called before timeout", async () => {
        await expect(
          bridge.connect(adapter).revertLockedTokens(lockId)
        ).to.be.revertedWithCustomError(bridge, "RevertLockedTokensTooEarly");
      });

      it("reverts if lock was already confirmed", async () => {
        const RECEIPT = ethers.keccak256(ethers.toUtf8Bytes("r"));
        await bridge
          .connect(adapter)
          .confirmLock(lockId, RECEIPT, DEST_CHAIN_ID, DEST_TOKEN);
        await time.increase(MAX_CONF_PERIOD + 1);
        await expect(
          bridge.connect(adapter).revertLockedTokens(lockId)
        ).to.be.revertedWithCustomError(bridge, "RevertNotAllowed");
      });

      it("reverts on double-revert", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        await expect(
          bridge.connect(adapter).revertLockedTokens(lockId)
        ).to.be.revertedWithCustomError(bridge, "AlreadyProcessed");
      });

      it("reverts on unknown lockId", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await expect(
          bridge.connect(adapter).revertLockedTokens(ethers.ZeroHash)
        ).to.be.revertedWithCustomError(bridge, "InvalidId");
      });

      it("reverts if called by non-adapter", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await expect(
          bridge.connect(stranger).revertLockedTokens(lockId)
        ).to.be.revertedWithCustomError(
          bridge,
          "AccessControlUnauthorizedAccount"
        );
      });

      it("reverts when paused", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(pauser).pause();
        await expect(
          bridge.connect(adapter).revertLockedTokens(lockId)
        ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
      });
    });

    // ── with fee — fee MUST be refunded on revert ─────────────────────────────
    describe("with 1% fee — fee is refunded on revert", function () {
      const FEE_RATE = 1000n;
      let lockId: string;
      let expectedFee: bigint;
      let expectedNet: bigint;

      beforeEach(async () => {
        await bridge.connect(admin).setFeeRate(FEE_RATE);
        expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        expectedNet = LOCK_AMOUNT - expectedFee;
        const tx = await bridge
          .connect(user1)
          .lockTokens(user2.address, LOCK_AMOUNT);
        lockId = await extractLockId(bridge, tx);
      });

      it("refunds full gross amount (net + fee) to sender", async () => {
        const balBefore = await token.balanceOf(user1.address);
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await token.balanceOf(user1.address)).to.equal(
          balBefore + LOCK_AMOUNT
        );
      });

      it("collectedFees decreases back to 0", async () => {
        expect(await bridge.collectedFees()).to.equal(expectedFee);
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.collectedFees()).to.equal(0n);
      });

      it("totalLockedSupply decreases by netAmount only", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.totalLockedSupply()).to.equal(0n);
      });

      it("emits RevertedLockedTokens with gross refund amount", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await expect(bridge.connect(adapter).revertLockedTokens(lockId))
          .to.emit(bridge, "RevertedLockedTokens")
          .withArgs(lockId, user1.address, LOCK_AMOUNT);
      });

      it("verifyParity is true after fee-revert", async () => {
        await time.increase(MAX_CONF_PERIOD + 1);
        await bridge.connect(adapter).revertLockedTokens(lockId);
        expect(await bridge.verifyParity()).to.be.true;
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // releaseTokens
  // ───────────────────────────────────────────────────────────────────────────
  describe("releaseTokens", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");
    const BURN_ID = ethers.keccak256(ethers.toUtf8Bytes("burn-tx-hash"));
    let maxTs: bigint;

    beforeEach(async () => {
      // Build up totalLockedSupply by locking tokens first
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      maxTs =
        BigInt(await time.latest()) + BigInt(MAX_CONF_PERIOD) + 7_200n;
    });

    // ── no fee ────────────────────────────────────────────────────────────────
    describe("without fee (feeRate = 0)", function () {
      it("releases full amount to recipient", async () => {
        const balBefore = await token.balanceOf(user2.address);
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await token.balanceOf(user2.address)).to.equal(
          balBefore + LOCK_AMOUNT
        );
      });

      it("totalLockedSupply decreases by full amount", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.totalLockedSupply()).to.equal(0n);
      });

      it("marks burnId as processed", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.processedReleases(BURN_ID)).to.be.true;
      });

      it("emits TokensReleased with zero feeAmount and netAmount = amount", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        )
          .to.emit(bridge, "TokensReleased")
          .withArgs(
            BURN_ID,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            LOCK_AMOUNT, // netAmount
            0n, // feeAmount
            tokenAddress,
            DEST_CHAIN_ID,
            DEST_TOKEN
          );
      });

      it("verifyParity is true after release", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.verifyParity()).to.be.true;
      });
    });

    // ── with fee ──────────────────────────────────────────────────────────────
    describe("with 1% fee (feeRate = 1000)", function () {
      const FEE_RATE = 1000n;
      let expectedFee: bigint;
      let expectedNet: bigint;

      beforeEach(async () => {
        await bridge.connect(admin).setFeeRate(FEE_RATE);
        expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
        expectedNet = LOCK_AMOUNT - expectedFee;
      });

      it("recipient receives netAmount (amount - fee)", async () => {
        const balBefore = await token.balanceOf(user2.address);
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await token.balanceOf(user2.address)).to.equal(
          balBefore + expectedNet
        );
      });

      it("collectedFees increases by feeAmount", async () => {
        // Note: lock was done before feeRate was set, so lock had 0 fee
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.collectedFees()).to.equal(expectedFee);
      });

      it("totalLockedSupply decreases by full amount (not net)", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.totalLockedSupply()).to.equal(0n);
      });

      it("emits TokensReleased with correct amounts", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        )
          .to.emit(bridge, "TokensReleased")
          .withArgs(
            BURN_ID,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            expectedNet,
            expectedFee,
            tokenAddress,
            DEST_CHAIN_ID,
            DEST_TOKEN
          );
      });

      it("verifyParity is true after release with fee", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await bridge.verifyParity()).to.be.true;
      });
    });

    // ── maxFeeAmount cap ──────────────────────────────────────────────────────
    describe("with maxFeeAmount cap", function () {
      it("caps release fee at maxFeeAmount", async () => {
        await bridge.connect(admin).setFeeRate(1000n); // 1% of 1000 = 10
        const cap = ethers.parseEther("5");
        await bridge.connect(admin).setMaxFeeAmount(cap);

        const balBefore = await token.balanceOf(user2.address);
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        expect(await token.balanceOf(user2.address)).to.equal(
          balBefore + LOCK_AMOUNT - cap
        );
        expect(await bridge.collectedFees()).to.equal(cap);
      });
    });

    // ── minBridgeAmount ───────────────────────────────────────────────────────
    describe("minBridgeAmount enforcement", function () {
      it("reverts when release amount < minBridgeAmount", async () => {
        await bridge
          .connect(admin)
          .setMinBridgeAmount(ethers.parseEther("2000"));
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "AmountBelowMinimum");
      });
    });

    // ── input validation ──────────────────────────────────────────────────────
    describe("input validation", function () {
      it("reverts on replay (burnId already processed)", async () => {
        await bridge
          .connect(adapter)
          .releaseTokens(
            BURN_ID,
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            LOCK_AMOUNT,
            maxTs
          );
        // Lock more tokens for the second release attempt
        await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs + 7200n
            )
        ).to.be.revertedWithCustomError(bridge, "AlreadyProcessed");
      });

      it("reverts on zero burnId", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              ethers.ZeroHash,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "InvalidId");
      });

      it("reverts on zero recipient", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              ethers.ZeroAddress,
              LOCK_AMOUNT,
              maxTs
            )
        )
          .to.be.revertedWithCustomError(bridge, "ZeroAddress")
          .withArgs("recipient");
      });

      it("reverts on zero amount", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              0n,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "InvalidAmount");
      });

      it("reverts on zero srcChainId", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              0n,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "InvalidChainId");
      });

      it("reverts when srcChainId != destChainId", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              137n,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "ReleaseNotAllowedFromSource");
      });

      it("reverts on zero srcTokenAddress", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              ethers.ZeroAddress,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "ZeroAddress");
      });

      it("reverts when srcTokenAddress != destTokenAddress", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              tokenAddress, // wrong token
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(
          bridge,
          "ReleaseNotAllowedFromSourceToken"
        );
      });

      it("reverts when maxConfirmationTimestamp is in the past", async () => {
        const pastTs = BigInt(await time.latest()) - 1n;
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              pastTs
            )
        ).to.be.revertedWithCustomError(bridge, "RequestTimeout");
      });

      it("reverts when totalLockedSupply < amount", async () => {
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT + 1n,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "InsufficientLockedSupply");
      });

      it("reverts if called by non-adapter", async () => {
        await expect(
          bridge
            .connect(stranger)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(
          bridge,
          "AccessControlUnauthorizedAccount"
        );
      });

      it("reverts when paused", async () => {
        await bridge.connect(pauser).pause();
        await expect(
          bridge
            .connect(adapter)
            .releaseTokens(
              BURN_ID,
              DEST_CHAIN_ID,
              DEST_TOKEN,
              user1.address,
              user2.address,
              LOCK_AMOUNT,
              maxTs
            )
        ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // withdrawFees
  // ───────────────────────────────────────────────────────────────────────────
  describe("withdrawFees", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");
    const FEE_RATE = 1000n; // 1%
    let expectedFee: bigint;

    beforeEach(async () => {
      await bridge.connect(admin).setFeeRate(FEE_RATE);
      expectedFee = (LOCK_AMOUNT * FEE_RATE) / FEE_DENOMINATOR;
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
    });

    it("admin withdraws full collected fees", async () => {
      const balBefore = await token.balanceOf(stranger.address);
      await bridge.connect(admin).withdrawFees(stranger.address, expectedFee);
      expect(await token.balanceOf(stranger.address)).to.equal(
        balBefore + expectedFee
      );
    });

    it("collectedFees decreases after withdrawal", async () => {
      await bridge.connect(admin).withdrawFees(stranger.address, expectedFee);
      expect(await bridge.collectedFees()).to.equal(0n);
    });

    it("partial withdrawal leaves correct remainder", async () => {
      const half = expectedFee / 2n;
      await bridge.connect(admin).withdrawFees(stranger.address, half);
      expect(await bridge.collectedFees()).to.equal(expectedFee - half);
    });

    it("emits FeesWithdrawn", async () => {
      await expect(
        bridge.connect(admin).withdrawFees(stranger.address, expectedFee)
      )
        .to.emit(bridge, "FeesWithdrawn")
        .withArgs(stranger.address, expectedFee);
    });

    it("verifyParity is true after withdrawal", async () => {
      await bridge.connect(admin).withdrawFees(stranger.address, expectedFee);
      // balance = totalLockedSupply + 0 collectedFees
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("reverts on zero recipient", async () => {
      await expect(
        bridge.connect(admin).withdrawFees(ethers.ZeroAddress, expectedFee)
      )
        .to.be.revertedWithCustomError(bridge, "ZeroAddress")
        .withArgs("to");
    });

    it("reverts on zero amount", async () => {
      await expect(
        bridge.connect(admin).withdrawFees(stranger.address, 0n)
      ).to.be.revertedWithCustomError(bridge, "InvalidAmount");
    });

    it("reverts when amount > collectedFees", async () => {
      await expect(
        bridge
          .connect(admin)
          .withdrawFees(stranger.address, expectedFee + 1n)
      )
        .to.be.revertedWithCustomError(bridge, "InsufficientFeeBalance")
        .withArgs(expectedFee, expectedFee + 1n);
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).withdrawFees(stranger.address, expectedFee)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // verifyParity / getExcessTokens / recoverExcessTokens
  // ───────────────────────────────────────────────────────────────────────────
  describe("verifyParity and getExcessTokens", function () {
    const LOCK_AMOUNT = ethers.parseEther("1000");

    it("returns true on fresh deploy (zero balance)", async () => {
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("returns true after a no-fee lock", async () => {
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("returns true after a fee-bearing lock", async () => {
      await bridge.connect(admin).setFeeRate(1000n);
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("returns true after a lock + revert", async () => {
      await bridge.connect(admin).setFeeRate(1000n);
      const tx = await bridge
        .connect(user1)
        .lockTokens(user2.address, LOCK_AMOUNT);
      const lockId = await extractLockId(bridge, tx);
      await time.increase(MAX_CONF_PERIOD + 1);
      await bridge.connect(adapter).revertLockedTokens(lockId);
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("getExcessTokens returns 0 when balanced", async () => {
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      expect(await bridge.getExcessTokens()).to.equal(0n);
    });

    it("returns false when tokens are sent directly to contract", async () => {
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      await token.mint(bridgeAddress, ethers.parseEther("1"));
      expect(await bridge.verifyParity()).to.be.false;
    });

    it("getExcessTokens returns the directly-sent surplus", async () => {
      await bridge.connect(user1).lockTokens(user2.address, LOCK_AMOUNT);
      const surplus = ethers.parseEther("50");
      await token.mint(bridgeAddress, surplus);
      expect(await bridge.getExcessTokens()).to.equal(surplus);
    });
  });

  describe("recoverExcessTokens", function () {
    it("admin recovers surplus tokens", async () => {
      await bridge.connect(user1).lockTokens(user2.address, ethers.parseEther("1000"));
      const surplus = ethers.parseEther("50");
      await token.mint(bridgeAddress, surplus);

      const balBefore = await token.balanceOf(admin.address);
      await bridge.connect(admin).recoverExcessTokens(admin.address);
      expect(await token.balanceOf(admin.address)).to.equal(
        balBefore + surplus
      );
    });

    it("does nothing if there is no excess", async () => {
      await expect(
        bridge.connect(admin).recoverExcessTokens(admin.address)
      ).to.not.be.reverted;
    });

    it("verifyParity is true after recovery", async () => {
      await token.mint(bridgeAddress, ethers.parseEther("100"));
      await bridge.connect(admin).recoverExcessTokens(admin.address);
      expect(await bridge.verifyParity()).to.be.true;
    });

    it("reverts on zero recipient", async () => {
      await expect(
        bridge.connect(admin).recoverExcessTokens(ethers.ZeroAddress)
      )
        .to.be.revertedWithCustomError(bridge, "ZeroAddress")
        .withArgs("to");
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).recoverExcessTokens(admin.address)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // rescueERC20
  // ───────────────────────────────────────────────────────────────────────────
  describe("rescueERC20", function () {
    it("admin can rescue a non-bridge ERC20 token", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const other = (await MockERC20Factory.deploy(
        "Other",
        "OTH"
      )) as MockERC20;
      const otherAddress = await other.getAddress();
      await other.mint(bridgeAddress, ethers.parseEther("100"));

      const balBefore = await other.balanceOf(admin.address);
      await bridge
        .connect(admin)
        .rescueERC20(otherAddress, admin.address, ethers.parseEther("100"));
      expect(await other.balanceOf(admin.address)).to.equal(
        balBefore + ethers.parseEther("100")
      );
    });

    it("reverts when trying to rescue the bridge token", async () => {
      await bridge
        .connect(user1)
        .lockTokens(user2.address, ethers.parseEther("100"));
      await expect(
        bridge
          .connect(admin)
          .rescueERC20(tokenAddress, admin.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(bridge, "RescueNotAllowed");
    });

    it("reverts on zero recipient", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20Factory.deploy("Other", "OTH");
      await expect(
        bridge
          .connect(admin)
          .rescueERC20(await other.getAddress(), ethers.ZeroAddress, 1n)
      )
        .to.be.revertedWithCustomError(bridge, "ZeroAddress")
        .withArgs("to");
    });

    it("reverts on zero amount", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20Factory.deploy("Other", "OTH");
      await expect(
        bridge
          .connect(admin)
          .rescueERC20(await other.getAddress(), admin.address, 0n)
      ).to.be.revertedWithCustomError(bridge, "InvalidAmount");
    });

    it("reverts if called by non-admin", async () => {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20Factory.deploy("Other", "OTH");
      await expect(
        bridge
          .connect(stranger)
          .rescueERC20(await other.getAddress(), stranger.address, 1n)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Pause / Unpause
  // ───────────────────────────────────────────────────────────────────────────
  describe("pause and unpause", function () {
    it("pauser can pause the contract", async () => {
      await bridge.connect(pauser).pause();
      expect(await bridge.paused()).to.be.true;
    });

    it("pauser can unpause the contract", async () => {
      await bridge.connect(pauser).pause();
      await bridge.connect(pauser).unpause();
      expect(await bridge.paused()).to.be.false;
    });

    it("non-pauser cannot pause", async () => {
      await expect(
        bridge.connect(stranger).pause()
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("lockTokens blocked when paused", async () => {
      await bridge.connect(pauser).pause();
      await expect(
        bridge
          .connect(user1)
          .lockTokens(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("releaseTokens blocked when paused", async () => {
      await bridge
        .connect(user1)
        .lockTokens(user2.address, ethers.parseEther("100"));
      await bridge.connect(pauser).pause();
      const maxTs = BigInt(await time.latest()) + 7200n;
      await expect(
        bridge
          .connect(adapter)
          .releaseTokens(
            ethers.keccak256(ethers.toUtf8Bytes("x")),
            DEST_CHAIN_ID,
            DEST_TOKEN,
            user1.address,
            user2.address,
            ethers.parseEther("100"),
            maxTs
          )
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("confirmLock blocked when paused", async () => {
      const tx = await bridge
        .connect(user1)
        .lockTokens(user2.address, ethers.parseEther("100"));
      const lockId = await extractLockId(bridge, tx);
      await bridge.connect(pauser).pause();
      await expect(
        bridge
          .connect(adapter)
          .confirmLock(
            lockId,
            ethers.keccak256(ethers.toUtf8Bytes("r")),
            DEST_CHAIN_ID,
            DEST_TOKEN
          )
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });

    it("revertLockedTokens blocked when paused", async () => {
      const tx = await bridge
        .connect(user1)
        .lockTokens(user2.address, ethers.parseEther("100"));
      const lockId = await extractLockId(bridge, tx);
      await time.increase(MAX_CONF_PERIOD + 1);
      await bridge.connect(pauser).pause();
      await expect(
        bridge.connect(adapter).revertLockedTokens(lockId)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // setMessageAdapter
  // ───────────────────────────────────────────────────────────────────────────
  describe("setMessageAdapter", function () {
    it("admin grants MESSAGE_ADAPTER_ROLE", async () => {
      await bridge.connect(admin).setMessageAdapter(stranger.address, true);
      expect(
        await bridge.hasRole(await bridge.MESSAGE_ADAPTER_ROLE(), stranger.address)
      ).to.be.true;
    });

    it("admin revokes MESSAGE_ADAPTER_ROLE", async () => {
      await bridge.connect(admin).setMessageAdapter(adapter.address, false);
      expect(
        await bridge.hasRole(await bridge.MESSAGE_ADAPTER_ROLE(), adapter.address)
      ).to.be.false;
    });

    it("reverts on zero adapter address", async () => {
      await expect(
        bridge.connect(admin).setMessageAdapter(ethers.ZeroAddress, true)
      )
        .to.be.revertedWithCustomError(bridge, "ZeroAddress")
        .withArgs("adapter");
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).setMessageAdapter(stranger.address, true)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // setMaxConfirmationPeriod
  // ───────────────────────────────────────────────────────────────────────────
  describe("setMaxConfirmationPeriod", function () {
    it("admin updates to a valid value", async () => {
      await bridge.connect(admin).setMaxConfirmationPeriod(7200);
      expect(await bridge.maxConfirmationPeriod()).to.equal(7200n);
    });

    it("accepts lower boundary: 300", async () => {
      await bridge.connect(admin).setMaxConfirmationPeriod(300);
      expect(await bridge.maxConfirmationPeriod()).to.equal(300n);
    });

    it("accepts upper boundary: 86400", async () => {
      await bridge.connect(admin).setMaxConfirmationPeriod(86400);
      expect(await bridge.maxConfirmationPeriod()).to.equal(86400n);
    });

    it("reverts when below 300", async () => {
      await expect(
        bridge.connect(admin).setMaxConfirmationPeriod(299)
      ).to.be.revertedWithCustomError(bridge, "InvalidConfirmationPeriod");
    });

    it("reverts when above 86400", async () => {
      await expect(
        bridge.connect(admin).setMaxConfirmationPeriod(86401)
      ).to.be.revertedWithCustomError(bridge, "InvalidConfirmationPeriod");
    });

    it("reverts if called by non-admin", async () => {
      await expect(
        bridge.connect(stranger).setMaxConfirmationPeriod(3600)
      ).to.be.revertedWithCustomError(
        bridge,
        "AccessControlUnauthorizedAccount"
      );
    });
  });
});
