import { httpApiGatewayV2Transport } from "../http/adapter";
import { messageQueueTransport } from "../mq/adapter";
import type { TransportAdapter } from "./transport";

/**
 * Ordered built-in transport registry, consulted once per invocation by
 * `detectTransport` (docs/ARCHITECTURE.md section 4).
 *
 * This array is the single registration point for transports; application
 * code never configures them. Order is detection-priority order and must stay
 * deterministic: the HTTP / API Gateway v2 adapter comes first, the Message
 * Queue trigger adapter second (issue #7). The two discriminators are
 * disjoint — `version === "2.0"` + canonical path fields vs a non-empty,
 * envelope-shaped `messages` array — so each event shape is claimed by exactly
 * one transport regardless of position.
 */
export const BUILTIN_TRANSPORTS: readonly TransportAdapter[] = [
  httpApiGatewayV2Transport,
  messageQueueTransport,
];
