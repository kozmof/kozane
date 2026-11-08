export type SuspensionStage =
  | "worker-fetch"
  | "worker-body"
  | "worker-hash"
  | "wasm-compile"
  | "initialize"
  | "validation"
  | "validation-reply";
/** Serialized into the test page. Holds one real startup stage without changing its deadline. */
export function installSuspensionDriver(stage: SuspensionStage): void {
  const originalWorker = window.Worker,
    originalFetch = window.fetch.bind(window);
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle),
    originalCompile = WebAssembly.compileStreaming.bind(WebAssembly);
  let release!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = {
    entered: false,
    finished: false,
    probeReplies: 0,
    connectionReplies: 0,
    baselineProbes: 0,
    baselineConnections: 0,
    result: undefined as Promise<any> | undefined,
    release,
    cleanup: () => {},
  };
  (window as any).suspensionCase = state;
  const pause = async () => {
    if (held) return;
    held = true;
    state.entered = true;
    state.baselineProbes = state.probeReplies;
    state.baselineConnections = state.connectionReplies;
    await gate;
  };
  window.Worker = class extends originalWorker {
    private readonly methods = new Map<number, string>();
    private heldId: number | undefined;
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      this.addEventListener("message", (event) => {
        if (stage === "validation-reply" && event.data.id === this.heldId && !held) {
          event.stopImmediatePropagation();
          const reply = event.data;
          void pause().then(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
        }
        const method = this.methods.get(event.data.id);
        if (method === "probe" && !event.data.error) state.probeReplies++;
        if (method === "connection" && event.data.result === true) state.connectionReplies++;
      });
    }
    postMessage(message: any, options?: Transferable[] | StructuredSerializeOptions) {
      this.methods.set(message.id, message.method);
      if (
        stage === "validation-reply" &&
        !held &&
        typeof message.sql === "string" &&
        message.sql.toLowerCase().includes("pragma integrity_check")
      )
        this.heldId = message.id;
      const send = () => {
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      };
      if (stage === "initialize" && message.method === "initialize" && !held) {
        void pause().then(send);
        return;
      }
      send();
    }
  };
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const target = args[0] instanceof Request ? args[0].url : String(args[0]);
    if (stage === "worker-fetch" && target.endsWith("/worker.js") && !held) await pause();
    const response = await originalFetch(...args);
    if (stage !== "worker-body" || !target.endsWith("/worker.js") || held) return response;
    const reader = response.body!.getReader();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        if (first) {
          first = false;
          const split = Math.max(1, Math.floor(chunk.value.length / 2));
          controller.enqueue(chunk.value.subarray(0, split));
          await pause();
          if (split < chunk.value.length) controller.enqueue(chunk.value.subarray(split));
        } else controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
    if (stage === "worker-hash" && !held) await pause();
    return originalDigest(...args);
  };
  WebAssembly.compileStreaming = async (source) => {
    if (stage === "wasm-compile" && !held) await pause();
    return originalCompile(source);
  };
  state.cleanup = () => {
    window.Worker = originalWorker;
    window.fetch = originalFetch;
    crypto.subtle.digest = originalDigest;
    WebAssembly.compileStreaming = originalCompile;
  };
  sessionStorage.setItem("kozane-demo:session", "preserved malformed copy");
  state.result = (window as any).restorationHarness
    .run(undefined, { beforeView: stage === "validation" ? pause : undefined })
    .then((result: any) => {
      state.finished = true;
      return result;
    });
}
