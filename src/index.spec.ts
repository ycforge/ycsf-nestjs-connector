describe("entry point", () => {
  it("loads cleanly while the public API is not yet defined", async () => {
    const entryPoint = await import("./index");

    expect(Object.keys(entryPoint)).toEqual([]);
  });
});
