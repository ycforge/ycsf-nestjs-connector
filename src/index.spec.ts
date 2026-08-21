import * as publicApi from "./index";

describe("public API surface", () => {
  it("exposes no runtime exports while every public contract is type-only", async () => {
    // The public API defined by issue #1 consists exclusively of erased type
    // declarations (docs/ARCHITECTURE.md section 7). Runtime exports arrive
    // with their owning issues (#3, #4, #8) and must extend this guard
    // deliberately instead of leaking implementations accidentally.
    const runtimeExportKeys = Object.keys(publicApi);

    expect(runtimeExportKeys).toEqual([]);
  });
});
