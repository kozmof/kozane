export class TaskspaceServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskspaceServiceError";
  }
}
