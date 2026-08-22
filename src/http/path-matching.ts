/**
 * Route path matching for the in-memory dispatcher (issue #6).
 *
 * The connector replaces the platform router with a small segment matcher:
 * NestJS hands routes to {@link YandexHttpAdapter} as Express-style strings
 * (`/cats/:id`), and the matcher reproduces just enough of that contract for
 * conventional controllers — static segments, `:param` captures and a `*`
 * tail wildcard. Deliberate limitations (kept out until a real need shows up):
 *
 * - no regular-expression or optional/quantifier syntax (`a(b)?c`, `/:x?`);
 *   unsupported patterns fail fast at registration instead of misrouting;
 * - `*` only matches a whole tail and captures no parameter (Express binds it
 *   as `req.params[0]`; here wildcard routes expose no extra params);
 * - matching is case-insensitive like Express' default router;
 * - matching operates on the decoded `rawPath` (DATA-ANALYSE.md section E3),
 *   so an encoded `%2F` inside one segment behaves like a separator.
 */

export interface PathPatternMatch {
  /** True when the pattern covers the request path. */
  readonly matched: boolean;
  /** Captured `:param` values, keyed by name (empty when unmatched). */
  readonly params: Readonly<Record<string, string>>;
}

type PatternSegment =
  { kind: "literal"; value: string } | { kind: "param"; name: string } | { kind: "wildcard" };

/**
 * A compiled route pattern reusable across invocations; compilation happens
 * once per route during cold-start registration, never per dispatch.
 */
export interface CompiledPathPattern {
  readonly source: string;
  match(path: string): PathPatternMatch;
  /** Express-style prefix test used by middleware mounts (`app.use('/x', …)`). */
  matchesPrefix(path: string): boolean;
}

const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

function splitSegments(path: string): string[] {
  // Trailing slashes never contribute a segment (Express normalizes them).
  const withoutTrailingSlash = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return withoutTrailingSlash.split("/").filter((segment) => segment.length > 0);
}

function parseSegment(raw: string): PatternSegment {
  if (raw === "*") {
    return { kind: "wildcard" };
  }
  if (raw.startsWith(":")) {
    if (raw.length < 2 || raw.includes("?") || raw.includes("(")) {
      throw new Error(
        `unsupported route parameter "${raw}" in path pattern; only plain ":name" segments are supported`,
      );
    }
    return { kind: "param", name: raw.slice(1) };
  }
  return { kind: "literal", value: raw };
}

/**
 * Compiles an Express-style path string. Throws on patterns outside the
 * supported subset so misconfiguration surfaces at cold start, not per
 * invocation.
 */
export function compilePathPattern(pattern: string): CompiledPathPattern {
  if (!pattern.startsWith("/")) {
    throw new Error(`route path must start with "/": "${pattern}"`);
  }
  const segments = splitSegments(pattern).map(parseSegment);
  let sawWildcard = false;
  for (const segment of segments) {
    if (sawWildcard) {
      throw new Error(`route wildcard "*" must be the final segment: "${pattern}"`);
    }
    if (segment.kind === "wildcard") {
      sawWildcard = true;
    }
  }

  return {
    source: pattern,
    match(path: string): PathPatternMatch {
      const requestSegments = splitSegments(path);
      const params: Record<string, string> = {};

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        if (segment.kind === "wildcard") {
          return { matched: true, params };
        }
        const requestSegment = requestSegments[index];
        if (requestSegment === undefined) {
          return { matched: false, params: NO_PARAMS };
        }
        if (segment.kind === "literal") {
          if (segment.value.toLowerCase() !== requestSegment.toLowerCase()) {
            return { matched: false, params: NO_PARAMS };
          }
          continue;
        }
        // Parameter capture: any single non-empty segment (splitSegments
        // already guarantees non-emptiness).
        params[segment.name] = requestSegment;
      }

      const matched = requestSegments.length === segments.length;
      return matched ? { matched: true, params } : { matched: false, params: NO_PARAMS };
    },

    matchesPrefix(path: string): boolean {
      if (segments.length === 0) {
        return true;
      }
      const requestSegments = splitSegments(path);
      if (requestSegments.length < segments.length) {
        return false;
      }
      // Prefix semantics mirror Express mounts: every pattern segment must
      // match the corresponding request segment; anything beyond the pattern
      // is allowed through.
      return segments.every((segment, index) => {
        const requestSegment = requestSegments[index]!;
        if (segment.kind === "wildcard") {
          return true;
        }
        if (segment.kind === "param") {
          return true;
        }
        return segment.value.toLowerCase() === requestSegment.toLowerCase();
      });
    },
  };
}
