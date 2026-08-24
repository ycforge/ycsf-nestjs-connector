import { createParamDecorator } from "@nestjs/common";
import type { ContextParameterDecorator } from "../decorators/decorator-contracts";
import { resolveInvocationExecutionContext } from "./invocation-scope";

/**
 * Module-private registration of decorated parameter positions, keyed by
 * method target (prototype or constructor for static methods) then property
 * key. Self-contained on purpose: no reflect-metadata global is involved.
 */
const registry = new WeakMap<object, Map<string | symbol | undefined, readonly number[]>>();

/**
 * `@YandexContext()` — injects the current invocation's normalized
 * {@link YandexExecutionContext} into a handler/controller method parameter
 * (issue #4).
 *
 * The decorator is a thin registration mechanism (AGENTS.md section 3.4): it
 * only records which parameter positions want the context. The value comes
 * from the invocation scope (`src/context/invocation-scope.ts`) — the same
 * transport-neutral source for HTTP and Message Queue executions:
 *
 * - Message Queue dispatch reads the module-private registry below and fills
 *   the registered positions itself (issue #8), so no framework metadata is
 *   involved on that path.
 * - HTTP/API Gateway controller arguments are built by Nest's own route
 *   proxies, which know nothing about connector registries; registered
 *   positions are therefore ALSO exposed as a framework-native route
 *   parameter whose factory pulls the context out of the active invocation
 *   scope during argument resolution. Both paths hand user code the identical
 *   frozen instance for one invocation (issue #14 E2E coverage).
 *
 * Parameter registration uses a module-private WeakMap registry instead of
 * reflect-metadata: the connector owns both ends (decoration and discovery),
 * so no global metadata namespace and no extra dependency is involved. The
 * framework bridge uses `createParamDecorator` — Nest's supported extension
 * point — never a second injection system.
 */
export const YandexContext: ContextParameterDecorator = () => {
  const routeParameter = createParamDecorator(() => resolveInvocationExecutionContext());
  return (target, propertyKey, parameterIndex) => {
    let indexesByProperty = registry.get(target);
    if (!indexesByProperty) {
      indexesByProperty = new Map();
      registry.set(target, indexesByProperty);
    }

    const existing = indexesByProperty.get(propertyKey) ?? [];
    if (!existing.includes(parameterIndex)) {
      // Sorted ascending keeps multi-parameter discovery deterministic.
      indexesByProperty.set(
        propertyKey,
        [...existing, parameterIndex].sort((left, right) => left - right),
      );
    }

    // Idempotent per position: repeated decoration of one parameter must not
    // stack duplicate framework metadata entries.
    routeParameter()(target, propertyKey, parameterIndex);
  };
};

/**
 * Discovers the parameter positions registered for {@link YandexContext} on a
 * method, ascending. Lookup walks the prototype chain so handlers inherited
 * from a decorated base class resolve too.
 *
 * Internal seam consumed by transport dispatch (issues #5, #7/#8) and specs;
 * deliberately not part of the public export surface.
 */
export function getYandexContextParameterIndexes(
  target: object,
  propertyKey: string | symbol | undefined,
): readonly number[] {
  let current: object | null = target;
  while (current) {
    const indexes = registry.get(current)?.get(propertyKey);
    if (indexes) {
      return indexes;
    }
    current = Object.getPrototypeOf(current);
  }
  return [];
}
