import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableSourceBridgeModule from "./OnestableSourceBridge";
import OnestableSourceRelayerAdapterModule from "./OnestableSourceRelayerAdapter";

const SourceDeploymentModule = buildModule("SourceDeploymentModule", (m) => {
  const { sourceBridge } = m.useModule(OnestableSourceBridgeModule);
  const { adapter } = m.useModule(OnestableSourceRelayerAdapterModule);

  m.call(sourceBridge, "setMessageAdapter", [adapter, true]);

  return { sourceBridge, adapter };
});

export default SourceDeploymentModule;
