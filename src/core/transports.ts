import { httpApiGatewayV2Transport } from "../http/adapter";
import type { TransportAdapter } from "./transport";

/**
 * Ordered built-in transport registry, consulted once per invocation by
 * `detectTransport` (docs/ARCHITECTURE.md section 4).
 *
 * This array is the single registration point for transports: the Message
 * Queue adapter (issue #7) will append its adapter here after the HTTP / API
 * Gateway entry in detection-priority order. Application code never
 * configures transports; adding one is an internal change only.
 */
export const BUILTIN_TRANSPORTS: readonly TransportAdapter[] = [httpApiGatewayV2Transport];
