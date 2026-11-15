import { expect, it } from "vitest";
import {
  decodeStorageValue,
  encodeStorageValue,
  parseTaggedRow,
  parseTaggedValue,
  RowEncodingError,
  taggedRowKey,
  taggedRowsEqual,
  type StorageValue,
} from "../../../core/src/actions/row-codec.js";

it.each([-(1n << 63n), (1n << 63n) - 1n, -9007199254740993n, 9007199254740993n, 0n])(
  "preserves INTEGER %s through JSON without a number conversion",
  (integer) => {
    const encoded = encodeStorageValue({ type: "integer", value: integer });
    expect(encoded).toEqual(["integer", integer.toString()]);
    expect(decodeStorageValue(JSON.parse(JSON.stringify(encoded)))).toEqual({
      type: "integer",
      value: integer,
    });
  },
);

it.each([0, -0, 1, -1.5, Number.MIN_VALUE, Number.MAX_VALUE, Math.PI])(
  "preserves finite REAL bits for %s",
  (real) => {
    const encoded = encodeStorageValue({ type: "real", value: real });
    const decoded = decodeStorageValue(JSON.parse(JSON.stringify(encoded)));
    expect(decoded.type).toBe("real");
    expect(Object.is(decoded.value, real)).toBe(true);
    expect(encodeStorageValue(decoded)).toEqual(encoded);
  },
);

it("uses the specified big-endian REAL encoding and distinguishes signed zeros", () => {
  expect(encodeStorageValue({ type: "real", value: 1 })).toEqual(["real", "3ff0000000000000"]);
  expect(
    taggedRowsEqual({ x: ["real", "0000000000000000"] }, { x: ["real", "8000000000000000"] }),
  ).toBe(false);
});

it.each(["", "a\u0000b", "日本語 🪁", "e\u0301", "é"])(
  "preserves Unicode TEXT without normalization %s",
  (text) => {
    expect(
      decodeStorageValue(
        JSON.parse(JSON.stringify(encodeStorageValue({ type: "text", value: text }))),
      ),
    ).toEqual({ type: "text", value: text });
  },
);

it.each([new Uint8Array(), new Uint8Array([0, 255, 128, 1])])(
  "preserves BLOB bytes %s",
  (bytes) => {
    const encoded = encodeStorageValue({ type: "blob", value: bytes });
    const decoded = decodeStorageValue(encoded);
    expect(decoded).toEqual({ type: "blob", value: bytes });
    bytes.fill(99);
    expect(decodeStorageValue(encoded)).toEqual(decoded);
  },
);

it("distinguishes NULL, absent images and missing columns", () => {
  expect(encodeStorageValue({ type: "null", value: null })).toEqual(["null"]);
  expect(decodeStorageValue(["null"])).toEqual({ type: "null", value: null });
  expect(() => parseTaggedRow(null)).toThrow(RowEncodingError);
  expect(taggedRowsEqual({ value: ["null"] }, {})).toBe(false);
});

it.each([
  null,
  5,
  {},
  [],
  ["null", null],
  ["text"],
  ["integer", 1],
  ["integer", "01"],
  ["integer", "+1"],
  ["integer", "-0"],
  ["integer", " 1"],
  ["integer", "9223372036854775808"],
  ["integer", "-9223372036854775809"],
  ["integer", "1.0"],
  ["real", "3FF0000000000000"],
  ["real", "0"],
  ["real", "7ff0000000000000"],
  ["real", "fff0000000000000"],
  ["real", "7ff8000000000000"],
  ["blob", "0"],
  ["blob", "FF"],
  ["blob", "gg"],
  ["text", "\ud800"],
  ["text", "\udfff"],
  ["unknown", "value"],
])("rejects malformed or unsupported tagged value %s", (value) => {
  expect(() => parseTaggedValue(value)).toThrow(RowEncodingError);
});

it("refuses INTEGER numbers and unsupported raw values", () => {
  for (const input of [
    { type: "integer", value: 9007199254740992 },
    { type: "real", value: Infinity },
    { type: "real", value: NaN },
    { type: "blob", value: "00" },
    { type: "null", value: 0 },
  ])
    expect(() => encodeStorageValue(input as unknown as StorageValue)).toThrow(RowEncodingError);
});

it("compares storage class and complete images independent of column order", () => {
  const a = { id: ["integer", "1"], content: ["text", "text"] };
  expect(taggedRowsEqual(a, { content: ["text", "text"], id: ["integer", "1"] })).toBe(true);
  expect(taggedRowsEqual(a, { content: ["text", "text"], id: ["real", "3ff0000000000000"] })).toBe(
    false,
  );
  expect(taggedRowsEqual(a, { id: ["integer", "1"] })).toBe(false);
  expect(taggedRowsEqual(a, { ...a, extra: ["null"] })).toBe(false);
});

it("builds stable composite keys with safe property-like column names", () => {
  const a = { scope_id: ["text", "s"], card_id: ["text", "c"] };
  expect(taggedRowKey(a)).toBe(taggedRowKey({ card_id: a.card_id, scope_id: a.scope_id }));
  expect(taggedRowKey(a)).not.toBe(taggedRowKey({ scope_id: a.scope_id }));
  const row = parseTaggedRow(JSON.parse('{"__proto__":["text","data"]}'));
  expect(Object.hasOwn(row, "__proto__")).toBe(true);
  expect(Object.isFrozen(row)).toBe(true);
  expect(Object.isFrozen(row.__proto__)).toBe(true);
  expect(() => taggedRowKey({})).toThrow(RowEncodingError);
});

it("rejects unknown encodings and reports the affected column without running row accessors", () => {
  expect(() => parseTaggedRow({}, 2)).toThrow("Unsupported row encoding: 2");
  const getter = {
    get column() {
      throw new Error("Accessor must not run");
    },
  };
  expect(() => parseTaggedRow(getter)).toThrow(
    "Row columns must be enumerable values in column column",
  );
  expect(() => parseTaggedRow({ column: ["blob", "invalid"] })).toThrow("in column column");
});

it("refuses tuple accessors and extra tuple properties without invoking them", () => {
  const accessor = ["text", "safe"];
  Object.defineProperty(accessor, "1", {
    get() {
      throw new Error("Accessor must not run");
    },
    enumerable: true,
  });
  expect(() => parseTaggedValue(accessor)).toThrow("plain data");
  expect(() => parseTaggedValue(Object.assign(["null"], { hidden: true }))).toThrow(
    "Malformed tagged row value",
  );
});
