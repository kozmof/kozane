import type { ClientCapabilities, MutationOptions, ReadOptions } from "../contract.js";
/** Resource wiring borrows one transport and lifetime from HttpClient. */
export interface HttpResourceContext {
  capabilities(): ClientCapabilities;
  disposed(): boolean;
  ns(namespaceId: string, path: string): string;
  read(path: string, options?: ReadOptions & { cache?: RequestInit["cache"] }): Promise<unknown>;
  readTaskspace<T>(
    path: string,
    decode: (value: unknown) => T | null,
    options?: ReadOptions,
  ): Promise<T>;
  writeTaskspace<T>(
    path: string,
    method: string,
    input: unknown,
    decode: (value: unknown) => T | null,
    options?: MutationOptions,
  ): Promise<T>;
  writeDomain<T, Input>(
    path: string,
    method: string,
    input: Input,
    decode: (value: unknown, input: Input) => T | null,
    options?: MutationOptions,
  ): Promise<T>;
}
