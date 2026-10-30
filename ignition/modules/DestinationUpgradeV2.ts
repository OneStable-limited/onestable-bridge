import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const DestinationUpgradeV2Module = buildModule(
  "DestinationUpgradeV2Module",
  (m) => {
    const proxy = m.getParameter("proxy");

    const implementation = m.contract("OnestableDestinationBridgeV2", [], {
      id: "OnestableDestinationBridgeV2Implementation",
    });
    const destinationBridge = m.contractAt(
      "OnestableDestinationBridgeV2",
      proxy,
      { id: "OnestableDestinationBridgeV2" }
    );

    // Comment below line if deployer & bridge upgrader is not same & call method externally
    m.call(
      destinationBridge,
      "upgradeToAndCall",
      [implementation, "0x"],
      { id: "UpgradeDestinationBridgeV2" }
    );

    return { destinationBridge, implementation };
  }
);

export default DestinationUpgradeV2Module;
