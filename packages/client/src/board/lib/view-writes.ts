import { operationKinds } from "../../client/operation-kinds.js";
import { ClientError, type KozaneClient } from "../../client/contract.js";

/** Bind UI mutation chains to one generation and check readiness at every dispatch. */
export function bindViewWrites<T extends Pick<KozaneClient, "version" | "state" | "capabilities">>(
  client: T,
  canWrite: () => boolean,
): T {
  const generation = client.version.generation;
  const wrapped = new Map<PropertyKey, object>();
  return new Proxy(Object.create(null) as T, {
    get(_target, key) {
      const resource = Reflect.get(client, key, client);
      if (typeof key !== "string" || !Object.hasOwn(operationKinds, key) || !resource)
        return typeof resource === "function" ? resource.bind(client) : resource;
      let api = wrapped.get(key);
      if (!api) {
        // Use a separate target because adapter API objects can be frozen.
        api = new Proxy(
          {},
          {
            get(_empty, method) {
              const call = Reflect.get(resource, method, resource);
              if (typeof call !== "function") return call;
              const kinds = operationKinds[key as keyof typeof operationKinds];
              if (Object.hasOwn(kinds, method) && Reflect.get(kinds, method) === "read")
                return call.bind(resource);
              return (...args: unknown[]) => {
                if (
                  client.capabilities.writable &&
                  (client.version.generation !== generation ||
                    client.state.status !== "ready" ||
                    !canWrite())
                ) {
                  return Promise.reject(new ClientError("unavailable", "The client is not ready"));
                }
                return call.apply(resource, args);
              };
            },
          },
        );
        wrapped.set(key, api);
      }
      return api;
    },
  });
}
