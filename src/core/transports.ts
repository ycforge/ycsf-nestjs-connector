import type { TransportAdapter } from "./transport";

/**
 * Ordered built-in transport registry, consulted once per invocation by
 * `detectTransport` (docs/ARCHITECTURE.md section 4).
 *
 * This array is the single registration point for transports: the HTTP / API
 * Gateway adapter (issue #5) and the Message Queue adapter (issue #7) append
 * their adapters here in detection-priority order. Application code never
 * configures transports; adding one is an internal change only.
 *
 * Deliberately empty until those adapters land — until then every invocation
 * fails with `UNKNOWN_INVOCATION_EVENT` instead of half-working behavior.
 */
export const BUILTIN_TRANSPORTS: readonly TransportAdapter[] = [];
