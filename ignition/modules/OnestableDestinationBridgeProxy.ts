import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const OnestableDestinationBridgeProxyModule = buildModule(
  "OnestableDestinationBridgeProxyModule",
  (m) => {
    const defaultAdmin = m.getParameter("defaultAdmin", m.getAccount(0));
    const pauser = m.getParameter("pauser", m.getAccount(0));
    const upgrader = m.getParameter("upgrader", m.getAccount(0));
    const bridgedToken = m.getParameter("bridgedToken");
    const srcChainIds = m.getParameter("srcChainIds");
    const srcTokenAddresses = m.getParameter("srcTokenAddresses");
    const maxConfirmationPeriod = m.getParameter(
      "maxConfirmationPeriod",
      86400
    );

    const destinationBridge = m.contract("OnestableDestinationBridge", [], {
      id: "OnestableDestinationBridgeImplementation",
    });
    const proxy = m.contract(
      "OnestableDestinationBridgeProxy",
      [
        destinationBridge,
        m.encodeFunctionCall(destinationBridge, "initialize", [
          bridgedToken,
          srcChainIds,
          srcTokenAddresses,
          maxConfirmationPeriod,
          defaultAdmin,
          pauser,
          upgrader,
        ]),
      ],
      { id: "OnestableDestinationBridgeProxy" }
    );

    return { proxy, implementation: destinationBridge };
  }
);

export default OnestableDestinationBridgeProxyModule;
