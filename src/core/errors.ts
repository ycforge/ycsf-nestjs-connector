import type { TransportId } from "./transport";

/**
 * Error codes reserved at the invocation boundary. Concrete error classes are
 * implemented together with the runtime bootstrap (issue #3) and the unified
 * retry/acknowledgement semantics (issue #10); they must carry one of these
 * codes so applications can branch on stable identifiers instead of messages.
 */
export type ConnectorErrorCode =
  "UNKNOWN_INVOCATION_EVENT" | "INVALID_INVOCATION_EVENT" | "UNSUPPORTED_ROUTE_PATTERN";

/**
 * Diagnostic detail attached to boundary errors. Values must never contain
 * credentials or client-sensitive data (AGENTS.md section 6).
 */
export interface ConnectorErrorDetail {
  readonly code: ConnectorErrorCode;
  /** Transport whose validation failed; absent when no transport claimed the event. */
  readonly transportId?: TransportId;
}
