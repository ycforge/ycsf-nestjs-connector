/**
 * Public API surface of @ycforge/ycsf-nestjs-connector.
 *
 * This file is the ONLY public entry point: `package.json` exposes just the
 * "." subpath, so deep imports of internal modules are blocked by design
 * (docs/ARCHITECTURE.md section 2).
 *
 * Rules for changing this file:
 * - every export must be listed explicitly in docs/ARCHITECTURE.md section 7;
 * - contracts ship as type-only exports until their runtime implementation
 *   lands with the owning issue (no half-working runtime code);
 * - never re-export whole modules or use wildcard barrels.
 */

// Core: transport SPI and shared invocation contracts.
export type {
  InjectableToken,
  InvocationContainer,
  TransportAdapter,
  TransportId,
  TransportInvocation,
  YandexCloudFunctionHandler,
} from "./core/transport";
export type { HasRaw } from "./core/raw-access";
export type { ConnectorErrorCode, ConnectorErrorDetail } from "./core/errors";

// HTTP / API Gateway v2 transport contracts.
export type { RawHttpApiGatewayV2Event, RawHttpApiGatewayV2RequestContext } from "./http/raw-event";
export type { NormalizedHttpRequest } from "./http/normalized-request";
export type { YandexFunctionHttpResponse } from "./http/response";

// Message Queue transport contracts.
export type {
  RawQueueEvent,
  RawQueueEventMetadata,
  RawQueueMessageAttributeValue,
  RawQueueMessageEvent,
} from "./mq/raw-event";
export type {
  QueueBatch,
  QueueEventMetadata,
  QueueMessage,
  QueueMessageAttribute,
} from "./mq/message";

// Normalized execution context.
export type { YandexExecutionContext } from "./context/yandex-execution-context";

// Decorator signatures (implementations arrive with issues #4 and #8).
export type {
  ContextParameterDecorator,
  QueueHandlerMethodDecorator,
  QueueMessageParameterDecorator,
} from "./decorators/decorator-contracts";
