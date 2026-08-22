import * as publicApi from "./index";

describe("public API surface", () => {
  it("exposes exactly the deliberate runtime exports", async () => {
    // Issue #1 shipped a type-only surface; issue #3 added the runtime
    // bootstrap, issue #4 the context decorator (docs/ARCHITECTURE.md
    // section 7). Every additional key must be added deliberately here and
    // in scripts/validate-package.mjs instead of leaking implementations
    // accidentally.
    const runtimeExportKeys = Object.keys(publicApi).sort();

    expect(runtimeExportKeys).toEqual(["ConnectorError", "YandexContext", "createYandexHandler"]);
  });
});
