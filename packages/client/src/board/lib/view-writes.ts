import { ClientError, type KozaneClient } from "../../backend/contract.js";

/** Bind UI mutation chains to one generation and check readiness at every dispatch. */
export function bindViewWrites(backend: KozaneClient, canWrite: () => boolean): KozaneClient {
  const generation = backend.version.generation;
  const resources = new Set([
    "cards",
    "glues",
    "layers",
    "partitions",
    "scopes",
    "warps",
    "inventories",
    "namespaces",
    "taskspaces",
  ]);
  const wrapped = new Map<PropertyKey, object>();
  return new Proxy(Object.create(null) as KozaneClient, {
    get(_target, key) {
      const resource = Reflect.get(backend, key, backend);
      if (typeof key !== "string" || !resources.has(key) || !resource)
        return typeof resource === "function" ? resource.bind(backend) : resource;
      let api = wrapped.get(key);
      if (!api) {
        // Use a separate target because adapter API objects can be frozen.
        api = new Proxy(
          {},
          {
            get(_empty, method) {
              const call = Reflect.get(resource, method, resource);
              if (typeof call !== "function") return call;
              const read =
                (key === "namespaces" && method !== "create") ||
                (key === "taskspaces" &&
                  (method === "access" || method === "readFile" || method === "list"));
              if (read) return call.bind(resource);
              return (...args: unknown[]) => {
                if (
                  backend.capabilities.writable &&
                  (backend.version.generation !== generation ||
                    backend.state.status !== "ready" ||
                    !canWrite())
                ) {
                  return Promise.reject(new ClientError("unavailable", "The backend is not ready"));
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
