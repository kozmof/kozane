/** Encode storage classes before ORM conversions. Integers never pass through JS numbers. */
export const ROW_ENCODING_VERSION = 1;
export type TaggedValue =
  | readonly ["null"]
  | readonly ["integer", string]
  | readonly ["real", string]
  | readonly ["text", string]
  | readonly ["blob", string];
export type TaggedRow = Readonly<Record<string, TaggedValue>>;
export type StorageValue =
  | { readonly type: "null"; readonly value: null }
  | { readonly type: "integer"; readonly value: bigint }
  | { readonly type: "real"; readonly value: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "blob"; readonly value: Uint8Array };

export class RowEncodingError extends Error {
  override readonly name = "RowEncodingError";
  constructor(
    message: string,
    readonly column?: string,
  ) {
    super(column === undefined ? message : `${message} in column ${column}`);
  }
}
const MIN_INTEGER = -(1n << 63n);
const MAX_INTEGER = (1n << 63n) - 1n;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** Validate canonical tuples from JSON transport. Return an immutable copy. */
export function parseTaggedValue(input: unknown): TaggedValue {
  if (!Array.isArray(input)) throw new RowEncodingError("Row value must be a tagged tuple");
  if (
    (input.length !== 1 && input.length !== 2) ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new RowEncodingError("Malformed tagged row value");
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new RowEncodingError("Tagged values must contain plain data");
    values.push(descriptor.value);
  }
  if (values.length === 1 && values[0] === "null") return Object.freeze(["null"]);
  if (values.length !== 2 || typeof values[1] !== "string")
    throw new RowEncodingError("Malformed tagged row value");
  const [tag, value] = values as [unknown, string];
  switch (tag) {
    case "integer": {
      if (
        !/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value) ||
        value.length > 20 ||
        value.trim() !== value
      )
        throw new RowEncodingError("Invalid canonical integer");
      const integer = BigInt(value);
      if (integer < MIN_INTEGER || integer > MAX_INTEGER)
        throw new RowEncodingError("Integer outside signed 64-bit range");
      return Object.freeze(["integer", value]);
    }
    case "real": {
      if (value.length !== 16 || !/^[0-9a-f]{16}$/.test(value))
        throw new RowEncodingError("Invalid REAL bits");
      const bytes = unhex(value);
      if (!Number.isFinite(new DataView(bytes.buffer).getFloat64(0, false)))
        throw new RowEncodingError("Non-finite REAL is unsupported");
      return Object.freeze(["real", value]);
    }
    case "text":
      if (!value.isWellFormed()) throw new RowEncodingError("TEXT is not well-formed Unicode");
      return Object.freeze(["text", value]);
    case "blob":
      if (value.length % 2 !== 0 || !/^(?:[0-9a-f]{2})*$/.test(value))
        throw new RowEncodingError("Invalid canonical BLOB bytes");
      return Object.freeze(["blob", value]);
    default:
      throw new RowEncodingError("Unknown row value tag");
  }
}

/** Call only with the actual SQLite storage class and an uncoerced value. */
export function encodeStorageValue(input: StorageValue): TaggedValue {
  switch (input.type) {
    case "null":
      if (input.value !== null) throw new RowEncodingError("Expected NULL");
      return parseTaggedValue(["null"]);
    case "integer":
      if (typeof input.value !== "bigint") throw new RowEncodingError("INTEGER requires bigint");
      return parseTaggedValue(["integer", input.value.toString()]);
    case "real": {
      if (typeof input.value !== "number" || !Number.isFinite(input.value))
        throw new RowEncodingError("REAL requires a finite number");
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, input.value, false);
      return parseTaggedValue(["real", hex(bytes)]);
    }
    case "text":
      return parseTaggedValue(["text", input.value]);
    case "blob":
      if (!(input.value instanceof Uint8Array)) throw new RowEncodingError("BLOB requires bytes");
      return parseTaggedValue(["blob", hex(input.value)]);
    default:
      throw new RowEncodingError("Unknown SQLite storage class");
  }
}

export function decodeStorageValue(input: unknown): StorageValue {
  const value = parseTaggedValue(input);
  switch (value[0]) {
    case "null":
      return { type: "null", value: null };
    case "integer":
      return { type: "integer", value: BigInt(value[1]) };
    case "real": {
      const bytes = unhex(value[1]);
      return { type: "real", value: new DataView(bytes.buffer).getFloat64(0, false) };
    }
    case "text":
      return { type: "text", value: value[1] };
    case "blob":
      return { type: "blob", value: unhex(value[1]) };
  }
}

export function parseTaggedRow(input: unknown, encodingVersion = ROW_ENCODING_VERSION): TaggedRow {
  if (encodingVersion !== ROW_ENCODING_VERSION)
    throw new RowEncodingError(`Unsupported row encoding: ${encodingVersion}`);
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw new RowEncodingError("Row must be an object of columns");
  const columns: [string, TaggedValue][] = [];
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !key.isWellFormed())
      throw new RowEncodingError("Invalid column name");
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new RowEncodingError("Row columns must be enumerable values", key);
    try {
      columns.push([key, parseTaggedValue(descriptor.value)]);
    } catch (error) {
      if (error instanceof RowEncodingError) throw new RowEncodingError(error.message, key);
      throw error;
    }
  }
  return Object.freeze(Object.fromEntries(columns));
}

/** Property order is irrelevant. Storage classes and the complete REAL bit pattern must match. */
export function taggedRowsEqual(left: unknown, right: unknown): boolean {
  const a = parseTaggedRow(left);
  const b = parseTaggedRow(right);
  const names = Object.keys(a);
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => {
      if (!Object.hasOwn(b, name)) return false;
      const first = a[name],
        second = b[name];
      return first[0] === second[0] && first[1] === second[1];
    })
  );
}

/** A stable projection key for a complete tagged primary-key object. */
export function taggedRowKey(input: unknown): string {
  const row = parseTaggedRow(input);
  if (Object.keys(row).length === 0) throw new RowEncodingError("Primary key must contain columns");
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((name) => [name, row[name]]),
    ),
  );
}
