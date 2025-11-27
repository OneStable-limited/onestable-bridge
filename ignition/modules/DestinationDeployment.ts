import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableDestinationBridgeModule from "./OnestableDestinationBridge";
import OnestableDestinationRelayerAdapterModule from "./OnestableDestinationRelayerAdapter";

const DestinationDeploymentModule = buildModule(
  "DestinationDeploymentModule",
  (m) => {
    const { destinationBridge } = m.useModule(OnestableDestinationBridgeModule);
    const { adapter } = m.useModule(OnestableDestinationRelayerAdapterModule);

    // Comment below line if deployer & bridge owner is not same & call method externally
    m.call(destinationBridge, "setMessageAdapter", [adapter, true]);

    return { destinationBridge, adapter };
  }
);

export default DestinationDeploymentModule;
