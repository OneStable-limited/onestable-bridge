require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TronWeb } = require("tronweb");

// ─── Network Config ────────────────────────────────────────────────────────────

const NETWORKS = {
  nile: {
    fullHost: "https://nile.trongrid.io",
    explorerUrl: "https://nile.tronscan.org/#/contract",
  },
  mainnet: {
    fullHost: "https://api.trongrid.io",
    explorerUrl: "https://tronscan.org/#/contract",
  },
};

const NETWORK = process.env.TRON_NETWORK || "nile";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function loadArtifact(contractName, dir = "") {
  const artifactPath = path.join(
    __dirname,
    `../artifacts/contracts/${dir.concat(
      contractName,
    )}.sol/${contractName}.json`,
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found: ${artifactPath}. Run 'npx hardhat compile' first.`,
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

// Encode initialize(args...) calldata using TronWeb ABI encoder
function encodeInitializeCall(
  tronWeb,
  abi,
  functionName = "initialize",
  args = [],
) {
  const fragment = abi.find(
    (f) => f.type === "function" && f.name === functionName,
  );
  if (!fragment) {
    throw new Error(`Function '${functionName}' not found in ABI`);
  }

  // TronWeb's encodeParams needs types and values separately
  const types = fragment.inputs.map((i) => i.type);
  const selector = TronWeb.sha3(
    `${functionName}(${types.join(",")})`,
    false,
  ).slice(0, 8); // first 4 bytes = function selector

  const encoded =
    args.length > 0 ? tronWeb.utils.abi.encodeParams(types, args) : "";
  const paramsHex = encoded.startsWith("0x") ? encoded.slice(2) : encoded;

  return "0x" + selector + paramsHex;
}

async function deployContract(
  tronWeb,
  abi,
  bytecode,
  constructorArgs = [],
  label = "",
) {
  console.log(`\n📦 Deploying ${label}...`);

  const tx = await tronWeb.contract().new({
    abi,
    bytecode,
    feeLimit: Number(process.env.TRON_FEE_LIMIT) || 1_000_000_000,
    callValue: 0,
    parameters: constructorArgs,
  });

  const base58 = tronWeb.address.fromHex(tx.address);
  console.log(`✅ ${label} deployed`);
  console.log(`   Base58  : ${base58}`);
  console.log(`   Hex     : ${tx.address}`);
  console.log(`   Explorer: ${NETWORKS[NETWORK].explorerUrl}/${base58}`);

  return { contract: tx, address: base58, hex: tx.address };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const net = NETWORKS[NETWORK];
  console.log(`\n🌐 Network : ${NETWORK} (${net.fullHost})`);

  const tronWeb = new TronWeb({
    fullHost: net.fullHost,
    privateKey: process.env.TRON_PRIVATE_KEY, // no 0x prefix
  });

  const deployer = tronWeb.defaultAddress.base58;
  console.log(`🔑 Deployer: ${deployer}`);

  const balance = await tronWeb.trx.getBalance(deployer);
  console.log(`💰 Balance : ${balance / 1e6} TRX`);

  if (balance === 0) {
    throw new Error(
      "Deployer has 0 TRX. Fund it at https://nileex.io/join/getJoinPage",
    );
  }

  // ── Step 1: Load artifacts ──────────────────────────────────────────────────
  const BridgeArtifact = loadArtifact("OnestableSourceBridge", "src/"); // 🔧 your impl contract name
  const ERC1967Artifact = loadArtifact("OnestableSourceBridgeProxy", "src/"); // from @openzeppelin/contracts
  const AdapterArtifact = loadArtifact("OnestableSourceRelayerAdapter", "src/");

  // ── Step 2: Deploy Implementation ──────────────────────────────────────────
  // UUPS impl constructor should be empty or take no args.
  // If yours has immutable args (e.g. WETH address), add them here.
  const impl = await deployContract(
    tronWeb,
    BridgeArtifact.abi,
    BridgeArtifact.bytecode,
    [],
    "Bridge Implementation",
  );

  // ── Step 3: Encode initialize() calldata ───────────────────────────────────
  // 🔧 Replace these with your actual initialize() arguments.
  // Order and types must match your initialize(arg1, arg2, ...) signature exactly.
  /**
   *  IERC20 _token,
      uint256 _destChainId,
      address _destTokenAddress,
      uint256 _maxConfirmationPeriod,
      address _defaultAdmin,
      address _pauser,
      address _upgrader
   */
  const initArgs =
    NETWORK === "mainnet"
      ? []
      : [
          "41ECa9bC828A3005B9a3b909f2cc5c2a54794DE05F",
          91562037,
          "41A402e19cbEAC809E1aed52ab71568e9462Bd5721",
          1800,
          "41C5B713eE1f425C1C0d3D7c7B5A7a9672701e086E",
          "41C5B713eE1f425C1C0d3D7c7B5A7a9672701e086E",
          "41C5B713eE1f425C1C0d3D7c7B5A7a9672701e086E",
        ];

  const initData = encodeInitializeCall(
    tronWeb,
    BridgeArtifact.abi,
    "initialize",
    [...initArgs],
  );

  console.log(`\n🔧 Encoded initData: ${initData}`);

  // ── Step 4: Deploy ERC1967Proxy(implAddress, initData) ─────────────────────
  // ERC1967Proxy constructor: (address implementation, bytes memory _data)
  // TronWeb expects hex address (not Base58) when passing as constructor arg
  const proxy = await deployContract(
    tronWeb,
    ERC1967Artifact.abi,
    ERC1967Artifact.bytecode,
    [
      impl.hex, // implementation address in hex
      initData, // initData as bytes
    ],
    "Bridge Proxy",
  );

  // ── Step 5: Attach impl ABI to proxy address for verification ──────────────
  console.log(`\n🔗 Proxy is live. Connect to it using Bridge ABI at:`);
  console.log(`   ${proxy.address}`);

  // ── Step 6: Deploy Adapter ────────────────────────────────────────────────────────────────
  const adapter = await deployContract(
    tronWeb,
    AdapterArtifact.abi,
    AdapterArtifact.bytecode,
    NETWORK === "mainnet"
      ? []
      : [
          "41C5B713eE1f425C1C0d3D7c7B5A7a9672701e086E",
          "41C5B713eE1f425C1C0d3D7c7B5A7a9672701e086E",
          proxy.hex,
        ],
    "Bridge Adapter",
  );

  // ── Step 7: Save deployment ────────────────────────────────────────────────
  const deployment = {
    network: NETWORK,
    deployer,
    timestamp: new Date().toISOString(),
    contracts: {
      implementation: { address: impl.address, hex: impl.hex },
      proxy: { address: proxy.address, hex: proxy.hex },
      adapter: { address: adapter.address, hex: adapter.hex },
    },
    // Handy for future upgrade scripts
    initArgs,
  };

  const outPath = path.join(__dirname, `../deployments/tron-${NETWORK}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log(`\n📄 Saved to deployments/tron-${NETWORK}.json`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(55)}`);
  console.log(`  Implementation : ${impl.address}`);
  console.log(`  Proxy          : ${proxy.address}`);
  console.log(`  Adapter        : ${adapter.address}`);
  console.log(`${"─".repeat(55)}\n`);

  // Whitelist Message Adapter in bridge manually
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err.message || err);
  process.exit(1);
});
