import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableSourceBridgeProxyModule from "./OnestableSourceBridgeProxy";

const OnestableSourceBridgeModule = buildModule(
  "OnestableSourceBridgeModule",
  (m) => {
    const { proxy } = m.useModule(OnestableSourceBridgeProxyModule);
    const sourceBridge = m.contractAt("OnestableSourceBridge", proxy);

    return { sourceBridge };
  }
);

export default OnestableSourceBridgeModule;
