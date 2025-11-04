import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import OnestableSourceBridgeModule from "./OnestableSourceBridge";

const OnestableSourceRelayerAdapterModule = buildModule(
  "OnestableSourceRelayerAdapterModule",
  (m) => {
    const { sourceBridge } = m.useModule(OnestableSourceBridgeModule);
    const owner = m.getParameter("owner", m.getAccount(0));
    const authorizedSigner = m.getParameter(
      "authorizedSigner",
      m.getAccount(0)
    );

    const adapter = m.contract("OnestableSourceRelayerAdapter", [
      owner,
      authorizedSigner,
      sourceBridge,
    ]);

    return { adapter };
  }
);

export default OnestableSourceRelayerAdapterModule;
