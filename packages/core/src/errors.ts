export class NotFoundError extends Error {
  constructor(label: string) {
    super(`${label} not found`);
    this.name = "NotFoundError";
  }
}

export class DefaultPartitionError extends Error {
  constructor() {
    super("Cannot delete the default partition");
    this.name = "DefaultPartitionError";
  }
}

export class DefaultLayerError extends Error {
  constructor() {
    super("Cannot delete the default layer");
    this.name = "DefaultLayerError";
  }
}

export class ValidationError extends Error {
  override name = "ValidationError";
}
export class ConflictError extends Error {
  override name = "ConflictError";
}
export class LimitError extends Error {
  override name = "LimitError";
}
export class UnavailableError extends Error {
  override name = "UnavailableError";
}
