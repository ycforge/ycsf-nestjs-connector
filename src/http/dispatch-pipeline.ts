import type { NormalizedHttpRequest } from "./normalized-request";
import type { CompiledPathPattern } from "./path-matching";
import type { YandexHttpRequestFacade, YandexRequestHandler } from "./request-facade";
import { createRequestFacade, declaresJsonContentType } from "./request-facade";
import type { YandexHttpResponseFacade } from "./response-facade";
import { createResponseFacade } from "./response-facade";
import type { YandexFunctionHttpResponse } from "./response";
import { serializeResponse } from "./serialize-response";

/** Uppercase HTTP verb, or `"*"` for method-independent registrations. */
export type HttpMethodOrAll = string;

export interface RouteRegistration {
  readonly method: HttpMethodOrAll;
  readonly pattern: CompiledPathPattern;
  readonly handler: YandexRequestHandler;
}

export interface MiddlewareRegistration {
  readonly pattern: CompiledPathPattern;
  readonly handler: YandexRequestHandler;
}

/**
 * Error-layer proxy as installed by NestJS (`setErrorHandler`): receives a
 * failure, runs exception filters and writes the mapped response.
 */
export type ErrorLayerProxy = (
  error: unknown,
  requestFacade: YandexHttpRequestFacade,
  responseFacade: YandexHttpResponseFacade,
  next: () => void,
) => void | Promise<void>;

export interface DispatchOptions {
  readonly request: NormalizedHttpRequest;
  readonly routes: readonly RouteRegistration[];
  readonly middlewares: readonly MiddlewareRegistration[];
  /** Whether JSON bodies parse into `req.body` (platform `bodyParser` option). */
  readonly jsonBodyParsingEnabled: boolean;
  /** Exception-layer proxies registered during application init. */
  readonly notFoundHandler?: YandexRequestHandler;
  readonly errorHandler?: ErrorLayerProxy;
}

interface RouteMatch {
  readonly registration: RouteRegistration;
  readonly params: Readonly<Record<string, string>>;
}

type StepFunction = (
  requestFacade: YandexHttpRequestFacade,
  responseFacade: YandexHttpResponseFacade,
  next: (error?: unknown) => void,
) => unknown;

function isRouteEligible(routeMethod: HttpMethodOrAll, requestMethod: string): boolean {
  // Method-independent routes always apply; HEAD falls back to GET handlers
  // exactly like platform routers do when no explicit HEAD route exists.
  return (
    routeMethod === "*" ||
    routeMethod === requestMethod ||
    (requestMethod === "HEAD" && routeMethod === "GET")
  );
}

function findMatchingRoute(
  routes: readonly RouteRegistration[],
  requestMethod: string,
  path: string,
): RouteMatch | undefined {
  for (const registration of routes) {
    if (!isRouteEligible(registration.method, requestMethod)) {
      continue;
    }
    const attempt = registration.pattern.match(path);
    if (attempt.matched) {
      return { registration, params: attempt.params };
    }
  }
  return undefined;
}

function writeJsonPayload(
  responseFacade: YandexHttpResponseFacade,
  statusCode: number,
  payload: object,
): void {
  responseFacade.statusCode = statusCode;
  responseFacade.setHeader("content-type", "application/json");
  responseFacade.send(JSON.stringify(payload));
}

/**
 * Defense-in-depth fallbacks; during normal operation Nest registers its own
 * layers which produce exactly these shapes (NotFoundException filter and
 * BaseExceptionFilter respectively).
 */
const DEFAULT_NOT_FOUND_BODY = { statusCode: 404 };

function defaultNotFoundHandler(requestMethod: string, path: string): YandexRequestHandler {
  return (_requestFacade, responseFacade) => {
    writeJsonPayload(responseFacade, 404, {
      ...DEFAULT_NOT_FOUND_BODY,
      message: `Cannot ${requestMethod} ${path}`,
    });
  };
}

function writeLastResortErrorResponse(responseFacade: YandexHttpResponseFacade): void {
  // Reached only when even the error layer fails; keeps the wire contract
  // deterministic instead of letting an unexpected rejection escape to the
  // gateway (which would surface a platform 502 including stack details).
  if (responseFacade.headersSent) {
    return;
  }
  writeJsonPayload(responseFacade, 500, { statusCode: 500, message: "Internal server error" });
}

/**
 * Executes one invocation against the registered middleware and routes
 * (issue #6): builds the per-invocation facades, drives the Express-style
 * chain — each step continues via `next()`, failures funnel into the error
 * layer — and serializes the accumulated state into the wire envelope.
 *
 * Deliberate simplifications over a platform router (documented limitations):
 * the first matching route wins (no fallthrough chains across same-method
 * routes), and `next()` must be called during the handler's synchronous or
 * awaited execution rather than deferred arbitrarily.
 */
export async function runDispatch(options: DispatchOptions): Promise<YandexFunctionHttpResponse> {
  const requestFacade = createRequestFacade(options.request);
  const responseFacade = createResponseFacade();

  const invokeErrorLayer = async (error: unknown): Promise<void> => {
    if (responseFacade.headersSent) {
      // The response already left the adapter; mirroring platform behavior,
      // late failures are not written onto the wire.
      return;
    }
    const errorLayer = options.errorHandler;
    if (!errorLayer) {
      writeLastResortErrorResponse(responseFacade);
      return;
    }
    try {
      await errorLayer(error, requestFacade, responseFacade, () => undefined);
    } catch {
      writeLastResortErrorResponse(responseFacade);
    }
  };

  // Body parsing runs as the first pipeline step exactly like the platform's
  // parser middleware: malformed JSON becomes a SyntaxError handed to
  // `next(err)`, which the error layer maps to a deterministic 400 response.
  let bodyParsed = false;
  const parseBodyStep: StepFunction = (_requestFacade, _response, next) => {
    if (
      !options.jsonBodyParsingEnabled ||
      bodyParsed ||
      requestFacade.rawBody === undefined ||
      !declaresJsonContentType(requestFacade.headers["content-type"])
    ) {
      next();
      return;
    }
    bodyParsed = true;
    try {
      requestFacade.body = JSON.parse(requestFacade.rawBody.toString("utf8"));
    } catch (error) {
      next(error);
      return;
    }
    next();
  };

  const middlewareSteps: StepFunction[] = [];
  for (const registration of options.middlewares) {
    if (registration.pattern.matchesPrefix(options.request.path)) {
      middlewareSteps.push(registration.handler);
    }
  }

  const requestMethod = options.request.method.toUpperCase();
  const routeStep: StepFunction = (_requestFacade, response, next) => {
    const match = findMatchingRoute(options.routes, requestMethod, options.request.path);
    if (!match) {
      const notFound =
        options.notFoundHandler ?? defaultNotFoundHandler(requestMethod, options.request.path);
      return notFound(requestFacade, response, next);
    }
    // Route parameters are bound per request, mirroring how a platform
    // router populates `req.params` right before invoking the handler.
    Object.assign(requestFacade.params, match.params);
    return match.registration.handler(requestFacade, response, next);
  };

  const steps: StepFunction[] = [parseBodyStep, ...middlewareSteps, routeStep];

  let index = -1;
  const drive = async (): Promise<void> => {
    while (true) {
      index += 1;
      const step = steps[index];
      if (step === undefined || responseFacade.headersSent) {
        return;
      }
      let continued = false;
      try {
        await step(requestFacade, responseFacade, (error?: unknown) => {
          if (continued) {
            throw new Error("next() called multiple times");
          }
          continued = true;
          if (error !== undefined && error !== null) {
            // Re-thrown so the failure funnels through the same path as
            // handler exceptions instead of continuing the chain.
            throw error;
          }
        });
        if (!continued) {
          return;
        }
      } catch (error) {
        await invokeErrorLayer(error);
        return;
      }
    }
  };

  await drive();

  return serializeResponse(responseFacade);
}
