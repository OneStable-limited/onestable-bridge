import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const OnestableSourceBridgeProxyModule = buildModule(
  "OnestableSourceBridgeProxyModule",
  (m) => {
    const defaultAdmin = m.getParameter("defaultAdmin", m.getAccount(0));
    const pauser = m.getParameter("pauser", m.getAccount(0));
    const upgrader = m.getParameter("upgrader", m.getAccount(0));
    const token = m.getParameter("token");
    const destChainId = m.getParameter("destChainId");
    const destTokenAddress = m.getParameter("destTokenAddress");
    const maxConfirmationPeriod = m.getParameter(
      "maxConfirmationPeriod",
      86400
    );

    const sourceBridge = m.contract("OnestableSourceBridge", [], {
      id: "OnestableSourceBridgeImplementation",
    });
    const proxy = m.contract(
      "OnestableSourceBridgeProxy",
      [
        sourceBridge,
        m.encodeFunctionCall(sourceBridge, "initialize", [
          token,
          destChainId,
          destTokenAddress,
          maxConfirmationPeriod,
          defaultAdmin,
          pauser,
          upgrader,
        ]),
      ],
      { id: "OnestableSourceBridgeProxy" }
    );

    return { proxy, implementation: sourceBridge };
  }
);

export default OnestableSourceBridgeProxyModule;
