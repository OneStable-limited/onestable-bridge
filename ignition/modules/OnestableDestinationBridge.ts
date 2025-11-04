import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableDestinationBridgeProxyModule from "./OnestableDestinationBridgeProxy";

const OnestableDestinationBridgeModule = buildModule(
  "OnestableDestinationBridgeModule",
  (m) => {
    const { proxy } = m.useModule(OnestableDestinationBridgeProxyModule);
    const destinationBridge = m.contractAt("OnestableDestinationBridge", proxy);

    return { destinationBridge };
  }
);

export default OnestableDestinationBridgeModule;
