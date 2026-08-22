import { extendInvocationScope, resolveInvocationHttpRequest } from "../context/invocation-scope";
import type { TransportAdapter, TransportId, TransportInvocation } from "../core/transport";
import type { YandexFunctionHttpResponse } from "./response";
import { normalizeHttpRequest } from "./normalize-request";
import type { RawHttpApiGatewayV2Event } from "./raw-event";
import { validateHttpApiGatewayV2Event } from "./validate-raw-event";

/**
 * Minimal wire-valid envelope returned while the connector ships without
 * response mapping: every claimed-and-valid HTTP invocation completes
 * deterministically instead of emitting an arbitrary payload to the gateway.
 * Status/header/body serialization and error mapping are owned by the
 * response adapter (issue #6), which replaces this placeholder.
 */
const REQUEST_ONLY_RESPONSE: YandexFunctionHttpResponse = Object.freeze({
  statusCode: 200,
  headers: Object.freeze({}),
  body: "",
  isBase64Encoded: false,
});

/**
 * Yandex API Gateway v2 HTTP transport (issue #5).
 *
 * Detection discriminator (**observed**, docs/ARCHITECTURE.md section 4):
 * payload format `"2.0"` plus the canonical `rawPath`/`rawQueryString`
 * fields. `supports()` stays cheap, deterministic, side-effect-free and
 * never throws — deeper structural validation happens once inside `invoke`
 * and reports violations as `INVALID_INVOCATION_EVENT`.
 *
 * The adapter is stateless: everything invocation-specific arrives on the
 * {@link TransportInvocation} and nothing survives the call, so the single
 * module-level instance is safe across warm and concurrent invocations
 * (AGENTS.md sections 10–11).
 */
export const httpApiGatewayV2Transport: TransportAdapter<
  RawHttpApiGatewayV2Event,
  YandexFunctionHttpResponse
> = {
  id: "http" satisfies TransportId,

  supports(rawEvent): rawEvent is RawHttpApiGatewayV2Event {
    if (typeof rawEvent !== "object" || rawEvent === null || Array.isArray(rawEvent)) {
      return false;
    }
    const candidate = rawEvent as Record<string, unknown>;
    return (
      candidate["version"] === "2.0" &&
      typeof candidate["rawPath"] === "string" &&
      typeof candidate["rawQueryString"] === "string"
    );
  },

  async invoke(
    invocation: TransportInvocation<RawHttpApiGatewayV2Event>,
  ): Promise<YandexFunctionHttpResponse> {
    const rawEvent = validateHttpApiGatewayV2Event(invocation.rawEvent);
    const normalizedRequest = normalizeHttpRequest(rawEvent);

    // Publish the normalized request into this invocation's scope before any
    // user code runs: NestJS code reached through the warm container can then
    // read conventional-HTTP semantics plus the execution context injected by
    // the core (@YandexContext()), isolated per invocation (AGENTS.md section
    // 11). Response mapping and controller dispatch arrive with issue #6.
    return extendInvocationScope({ httpRequest: normalizedRequest }, async () => {
      // In-scope read-back guard: the publication contract above is enforced
      // on every invocation exactly the way future dispatch will consume it.
      if (resolveInvocationHttpRequest() !== normalizedRequest) {
        throw new Error("the HTTP transport failed to publish its normalized request");
      }
      return REQUEST_ONLY_RESPONSE;
    });
  },
};
