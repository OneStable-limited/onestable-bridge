import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableDestinationBridgeModule from "./OnestableDestinationBridge";
import OnestableDestinationRelayerAdapterModule from "./OnestableDestinationRelayerAdapter";

const DestinationDeploymentModule = buildModule(
  "DestinationDeploymentModule",
  (m) => {
    const { destinationBridge } = m.useModule(OnestableDestinationBridgeModule);
    const { adapter } = m.useModule(OnestableDestinationRelayerAdapterModule);

    m.call(destinationBridge, "setMessageAdapter", [adapter, true]);

    return { destinationBridge, adapter };
  }
);

export default DestinationDeploymentModule;
