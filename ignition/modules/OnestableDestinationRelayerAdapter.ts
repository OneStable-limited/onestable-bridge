import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableDestinationBridgeModule from "./OnestableDestinationBridge";

const OnestableDestinationRelayerAdapterModule = buildModule(
  "OnestableDestinationRelayerAdapterModule",
  (m) => {
    const { destinationBridge } = m.useModule(OnestableDestinationBridgeModule);
    const owner = m.getParameter("owner", m.getAccount(0));
    const authorizedSigner = m.getParameter(
      "authorizedSigner",
      m.getAccount(0)
    );

    const adapter = m.contract("OnestableDestinationRelayerAdapter", [
      owner,
      authorizedSigner,
      destinationBridge,
    ]);

    return { adapter };
  }
);

export default OnestableDestinationRelayerAdapterModule;
