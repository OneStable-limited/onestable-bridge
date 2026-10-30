import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SourceUpgradeV2Module = buildModule("SourceUpgradeV2Module", (m) => {
  const proxy = m.getParameter("proxy");
  const owner = m.getParameter("owner", m.getAccount(0));
  const authorizedSigner = m.getParameter(
    "authorizedSigner",
    m.getAccount(0)
  );

  const implementation = m.contract("OnestableSourceBridgeV2", [], {
    id: "OnestableSourceBridgeV2Implementation",
  });
  const sourceBridge = m.contractAt("OnestableSourceBridgeV2", proxy, {
    id: "OnestableSourceBridgeV2",
  });

  // Comment below line if deployer & bridge upgrader is not same & call method externally
  m.call(
    sourceBridge,
    "upgradeToAndCall",
    [implementation, "0x"],
    { id: "UpgradeSourceBridgeV2" }
  );

  const adapter = m.contract(
    "OnestableSourceRelayerAdapterV2",
    [owner, authorizedSigner, sourceBridge],
    { id: "OnestableSourceRelayerAdapterV2" }
  );

  // Comment below line if deployer & bridge owner is not same & call method externally
  m.call(sourceBridge, "setMessageAdapter", [adapter, true]);

  return { sourceBridge, implementation, adapter };
});

export default SourceUpgradeV2Module;
