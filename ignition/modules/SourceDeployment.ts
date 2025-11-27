import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableSourceBridgeModule from "./OnestableSourceBridge";
import OnestableSourceRelayerAdapterModule from "./OnestableSourceRelayerAdapter";

const SourceDeploymentModule = buildModule("SourceDeploymentModule", (m) => {
  const { sourceBridge } = m.useModule(OnestableSourceBridgeModule);
  const { adapter } = m.useModule(OnestableSourceRelayerAdapterModule);

  // Comment below line if deployer & bridge owner is not same & call method externally
  m.call(sourceBridge, "setMessageAdapter", [adapter, true]);

  return { sourceBridge, adapter };
});

export default SourceDeploymentModule;
