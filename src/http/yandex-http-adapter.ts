import { RequestMethod } from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core";
import type { NormalizedHttpRequest } from "./normalized-request";
import { compilePathPattern } from "./path-matching";
import type { YandexHttpRequestFacade, YandexRequestHandler } from "./request-facade";
import type { YandexHttpResponseFacade } from "./response-facade";
import type { YandexFunctionHttpResponse } from "./response";
import {
  runDispatch,
  type ErrorLayerProxy,
  type MiddlewareRegistration,
  type RouteRegistration,
} from "./dispatch-pipeline";

/**
 * Adapter configuration; `jsonBodyParsingEnabled` flips to `true` when Nest
 * calls {@linkcode YandexHttpAdapter.registerParserMiddleware} during
 * `app.init()` (mirroring the platform `bodyParser` option, default enabled).
 */
interface AdapterOptions {
  jsonBodyParsingEnabled: boolean;
}

const INITIAL_ADAPTER_OPTIONS: AdapterOptions = { jsonBodyParsingEnabled: false };

/**
 * In-memory HTTP adapter over which the connector bootstraps NestJS
 * (issue #6). It implements the platform SPI without a Node HTTP server:
 * routes and middleware are recorded during cold start (`app.init()`), and
 * every invocation replays them in memory against the normalized gateway
 * request via {@link runDispatch}.
 *
 * Per AGENTS.md section 11 nothing invocation-specific lives on the adapter —
 * request/response state is created per dispatch — so one instance per
 * created handler is safe across warm and concurrent invocations.
 */
export class YandexHttpAdapter extends AbstractHttpAdapter<
  undefined,
  YandexHttpRequestFacade,
  YandexHttpResponseFacade
> {
  private readonly adapterOptions: AdapterOptions;

  private readonly routes: RouteRegistration[] = [];
  private readonly middlewares: MiddlewareRegistration[] = [];

  private notFoundLayer: YandexRequestHandler | undefined;
  private errorLayer: ErrorLayerProxy | undefined;

  constructor(adapterOptions: AdapterOptions = INITIAL_ADAPTER_OPTIONS) {
    super(undefined);
    // Copied on purpose: registration mutates parsing state while the caller
    // may retain its options object.
    this.adapterOptions = { ...adapterOptions };
  }

  /** Runs one normalized gateway request through the registered pipeline. */
  dispatch(normalizedRequest: NormalizedHttpRequest): Promise<YandexFunctionHttpResponse> {
    return runDispatch({
      request: normalizedRequest,
      routes: this.routes,
      middlewares: this.middlewares,
      jsonBodyParsingEnabled: this.adapterOptions.jsonBodyParsingEnabled,
      notFoundHandler: this.notFoundLayer,
      errorHandler: this.errorLayer,
    });
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle: a cloud function never listens on a socket.
  // ---------------------------------------------------------------------------

  override async initHttpServer(): Promise<void> {}

  override async close(): Promise<void> {}

  override listen(): never {
    throw new Error(
      "YandexHttpAdapter cannot listen on a port: Yandex Cloud Functions invokes the handler directly",
    );
  }

  override getHttpServer(): undefined {
    return undefined;
  }

  override setHttpServer(): void {}

  override getType(): string {
    return "yandex-api-gateway-v2";
  }

  // ---------------------------------------------------------------------------
  // Unsupported platform features fail fast at cold start.
  // ---------------------------------------------------------------------------

  override useStaticAssets(): never {
    throw new Error("static assets are not supported under Yandex Cloud Functions");
  }

  override setViewEngine(): never {
    throw new Error("server-side view rendering is not supported under Yandex Cloud Functions");
  }

  override render(): never {
    throw new Error("server-side view rendering is not supported under Yandex Cloud Functions");
  }

  override enableCors(): never {
    throw new Error(
      "adapter-level CORS is not supported; configure CORS on the API Gateway instead",
    );
  }

  override applyVersionFilter(): never {
    throw new Error(
      "controller versioning is not supported by the Yandex Cloud Functions connector",
    );
  }

  // ---------------------------------------------------------------------------
  // Request/response SPI consumed by the Nest router pipeline.
  // ---------------------------------------------------------------------------

  override getRequestHostname(requestFacade: YandexHttpRequestFacade): string {
    return requestFacade.hostname;
  }

  override getRequestMethod(requestFacade: YandexHttpRequestFacade): string {
    return requestFacade.method;
  }

  override getRequestUrl(requestFacade: YandexHttpRequestFacade): string {
    return requestFacade.url;
  }

  override status(
    responseFacade: YandexHttpResponseFacade,
    statusCode: number,
  ): YandexHttpResponseFacade {
    return responseFacade.status(statusCode);
  }

  override reply(
    responseFacade: YandexHttpResponseFacade,
    body: unknown,
    statusCode?: number,
  ): YandexHttpResponseFacade {
    if (statusCode !== undefined) {
      responseFacade.status(statusCode);
    }
    if (body === undefined || body === null) {
      responseFacade.end();
      return responseFacade;
    }
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      responseFacade.send(body);
    } else {
      responseFacade.json(body);
    }
    return responseFacade;
  }

  override end(responseFacade: YandexHttpResponseFacade, message?: string): void {
    if (message !== undefined) {
      responseFacade.send(message);
      return;
    }
    responseFacade.end();
  }

  override redirect(
    responseFacade: YandexHttpResponseFacade,
    statusCode: number,
    url: string,
  ): void {
    responseFacade.redirect(statusCode, url);
  }

  override isHeadersSent(responseFacade: YandexHttpResponseFacade): boolean {
    return responseFacade.headersSent;
  }

  override getHeader(responseFacade: YandexHttpResponseFacade, name: string): string | undefined {
    return responseFacade.getHeader(name);
  }

  override setHeader(responseFacade: YandexHttpResponseFacade, name: string, value: string): void {
    responseFacade.setHeader(name, value);
  }

  override appendHeader(
    responseFacade: YandexHttpResponseFacade,
    name: string,
    value: string,
  ): void {
    responseFacade.appendHeader(name, value);
  }

  override registerParserMiddleware(): void {
    // Called once during app.init() unless the application opts out with
    // `bodyParser: false`; enables JSON body parsing for all later
    // invocations of this warm application.
    this.adapterOptions.jsonBodyParsingEnabled = true;
  }

  override setErrorHandler(handler: ErrorLayerProxy): void {
    this.errorLayer = handler;
  }

  override setNotFoundHandler(handler: YandexRequestHandler): void {
    this.notFoundLayer = handler;
  }

  override createMiddlewareFactory(): (
    path: string,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors the platform SPI declaration; see below
    callback: Function,
  ) => void {
    // Method gating for method-scoped middleware happens inside the Nest
    // middleware module wrapper; the connector stores every entry in one
    // ordered chain.
    //
    // The `Function` parameter mirrors the platform SPI declaration verbatim;
    // narrowing it is impossible because the base type compares the returned
    // registrar strictly against `callback: Function`. Every value crossing
    // here comes from Nest's router proxies, which share the connector's
    // (req, res, next) contract (verified against @nestjs/core 11 sources),
    // so the conversion below is safe by construction.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    return (path, callback: Function): void => {
      this.middlewares.push({
        pattern: compilePathPattern(path),
        handler: callback as unknown as YandexRequestHandler,
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Route registration: recorded for in-memory replay during dispatch.
  //
  // Every verb exposes both platform call shapes ((path, handler) and bare
  // (handler)) so handler parameters are contextually typed instead of
  // collapsing into `any`.
  // ---------------------------------------------------------------------------

  override use(path: string, handler: YandexRequestHandler): void;
  override use(handler: YandexRequestHandler): void;
  override use(pathOrHandler: string | YandexRequestHandler, handler?: YandexRequestHandler): void {
    const path = typeof pathOrHandler === "string" ? pathOrHandler : "/";
    const middleware = typeof pathOrHandler === "string" ? handler : pathOrHandler;
    if (typeof middleware !== "function") {
      throw new Error("use() requires a middleware handler");
    }
    this.middlewares.push({
      pattern: compilePathPattern(path),
      handler: middleware,
    });
  }

  private registerRoute(
    method: RequestMethod,
    pathOrHandler: string | YandexRequestHandler,
    maybeHandler?: YandexRequestHandler,
  ): void {
    const path = typeof pathOrHandler === "string" ? pathOrHandler : "/";
    const handler = typeof pathOrHandler === "string" ? maybeHandler : pathOrHandler;
    if (typeof handler !== "function") {
      throw new Error(`route registration for "${method}" requires a handler`);
    }
    this.routes.push({
      method: method === RequestMethod.ALL ? "*" : RequestMethod[method],
      pattern: compilePathPattern(path),
      handler,
    });
  }

  override get(path: string, handler: YandexRequestHandler): void;
  override get(handler: YandexRequestHandler): void;
  override get(pathOrHandler: string | YandexRequestHandler, handler?: YandexRequestHandler): void {
    this.registerRoute(RequestMethod.GET, pathOrHandler, handler);
  }

  override post(path: string, handler: YandexRequestHandler): void;
  override post(handler: YandexRequestHandler): void;
  override post(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.POST, pathOrHandler, handler);
  }

  override put(path: string, handler: YandexRequestHandler): void;
  override put(handler: YandexRequestHandler): void;
  override put(pathOrHandler: string | YandexRequestHandler, handler?: YandexRequestHandler): void {
    this.registerRoute(RequestMethod.PUT, pathOrHandler, handler);
  }

  override delete(path: string, handler: YandexRequestHandler): void;
  override delete(handler: YandexRequestHandler): void;
  override delete(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.DELETE, pathOrHandler, handler);
  }

  override patch(path: string, handler: YandexRequestHandler): void;
  override patch(handler: YandexRequestHandler): void;
  override patch(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.PATCH, pathOrHandler, handler);
  }

  override options(path: string, handler: YandexRequestHandler): void;
  override options(handler: YandexRequestHandler): void;
  override options(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.OPTIONS, pathOrHandler, handler);
  }

  override head(path: string, handler: YandexRequestHandler): void;
  override head(handler: YandexRequestHandler): void;
  override head(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.HEAD, pathOrHandler, handler);
  }

  override search(path: string, handler: YandexRequestHandler): void;
  override search(handler: YandexRequestHandler): void;
  override search(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.SEARCH, pathOrHandler, handler);
  }

  override query(path: string, handler: YandexRequestHandler): void;
  override query(handler: YandexRequestHandler): void;
  override query(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.QUERY, pathOrHandler, handler);
  }

  override propfind(path: string, handler: YandexRequestHandler): void;
  override propfind(handler: YandexRequestHandler): void;
  override propfind(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.PROPFIND, pathOrHandler, handler);
  }

  override proppatch(path: string, handler: YandexRequestHandler): void;
  override proppatch(handler: YandexRequestHandler): void;
  override proppatch(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.PROPPATCH, pathOrHandler, handler);
  }

  override mkcol(path: string, handler: YandexRequestHandler): void;
  override mkcol(handler: YandexRequestHandler): void;
  override mkcol(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.MKCOL, pathOrHandler, handler);
  }

  override copy(path: string, handler: YandexRequestHandler): void;
  override copy(handler: YandexRequestHandler): void;
  override copy(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.COPY, pathOrHandler, handler);
  }

  override move(path: string, handler: YandexRequestHandler): void;
  override move(handler: YandexRequestHandler): void;
  override move(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.MOVE, pathOrHandler, handler);
  }

  override lock(path: string, handler: YandexRequestHandler): void;
  override lock(handler: YandexRequestHandler): void;
  override lock(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.LOCK, pathOrHandler, handler);
  }

  override unlock(path: string, handler: YandexRequestHandler): void;
  override unlock(handler: YandexRequestHandler): void;
  override unlock(
    pathOrHandler: string | YandexRequestHandler,
    handler?: YandexRequestHandler,
  ): void {
    this.registerRoute(RequestMethod.UNLOCK, pathOrHandler, handler);
  }

  override all(path: string, handler: YandexRequestHandler): void;
  override all(handler: YandexRequestHandler): void;
  override all(pathOrHandler: string | YandexRequestHandler, handler?: YandexRequestHandler): void {
    this.registerRoute(RequestMethod.ALL, pathOrHandler, handler);
  }
}
