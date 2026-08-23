import * as publicApi from "./index";

describe("public API surface", () => {
  it("exposes exactly the deliberate runtime exports", async () => {
    // Issue #1 shipped a type-only surface; issue #3 added the runtime
    // bootstrap, issue #4 the context decorator, issue #8 the queue
    // decorators, issue #13 the safe-diagnostics serializer
    // (docs/ARCHITECTURE.md section 7). Every additional key must be added
    // deliberately here and in scripts/validate-package.mjs instead of
    // leaking implementations accidentally.
    const runtimeExportKeys = Object.keys(publicApi).sort();

    expect(runtimeExportKeys).toEqual([
      "ConnectorError",
      "QueueHandler",
      "QueueMessage",
      "YandexContext",
      "createYandexHandler",
      "safeDiagnostics",
    ]);
  });

  it("ships QueueMessage as a merged value-plus-type export", () => {
    // The decorator must stay callable and the normalized message contract
    // importable under the same pinned name (docs/ARCHITECTURE.md section 7).
    expect(typeof publicApi.QueueMessage).toBe("function");
  });
});
