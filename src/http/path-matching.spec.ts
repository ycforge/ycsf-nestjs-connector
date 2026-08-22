import { compilePathPattern } from "./path-matching";

/**
 * Unit specs for the connector's segment matcher (issue #6): the subset of
 * Express-style routing the in-memory dispatcher supports. Every documented
 * limitation has a spec pinning it so future changes are deliberate.
 */
describe("compilePathPattern", () => {
  describe("static paths", () => {
    it("matches exact static paths", () => {
      const pattern = compilePathPattern("/health/live");
      expect(pattern.match("/health/live").matched).toBe(true);
    });

    it("ignores trailing slashes on both pattern and request path", () => {
      const pattern = compilePathPattern("/health/");
      expect(pattern.match("/health/").matched).toBe(true);
      expect(pattern.match("/health").matched).toBe(true);
    });

    it("compares case-insensitively like the platform default router", () => {
      const pattern = compilePathPattern("/Cats/List");
      expect(pattern.match("/cats/list").matched).toBe(true);
    });
  });

  describe(":param segments", () => {
    it("captures a single named segment per parameter", () => {
      const pattern = compilePathPattern("/users/:userId");
      const match = pattern.match("/users/42");
      expect(match.matched).toBe(true);
      expect(match.params).toEqual({ userId: "42" });
    });

    it("captures multiple parameters in order", () => {
      const pattern = compilePathPattern("/orgs/:orgId/repos/:repoId");
      const match = pattern.match("/orgs/acme/repos/widgets");
      expect(match.params).toEqual({ orgId: "acme", repoId: "widgets" });
    });

    it("does not let one :param span multiple segments", () => {
      const pattern = compilePathPattern("/files/:name");
      expect(pattern.match("/files/a/b").matched).toBe(false);
    });

    it("rejects unsupported quantifier syntax at compile time", () => {
      expect(() => compilePathPattern("/files/:name?")).toThrow(/unsupported route parameter/);
      expect(() => compilePathPattern("/files/:name(\\d+)")).toThrow(/unsupported route parameter/);
    });
  });

  describe("* wildcard tail", () => {
    it("matches any remaining path including empty remainder", () => {
      const pattern = compilePathPattern("/assets/*");
      expect(pattern.match("/assets/img/logo.png").matched).toBe(true);
      expect(pattern.match("/assets").matched).toBe(true);
    });

    it("requires the wildcard prefix to match first", () => {
      const pattern = compilePathPattern("/assets/*");
      expect(pattern.match("/images/logo.png").matched).toBe(false);
    });

    it("rejects wildcards that are not the final segment", () => {
      expect(() => compilePathPattern("/a/*/b")).toThrow(/wildcard/);
    });
  });

  describe("structural validation", () => {
    it("rejects patterns without a leading slash", () => {
      expect(() => compilePathPattern("health")).toThrow(/must start with/);
    });
  });
});
