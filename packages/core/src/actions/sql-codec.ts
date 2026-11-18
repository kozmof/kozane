import {
  decodeStorageValue,
  parseTaggedRow,
  parseTaggedValue,
  RowEncodingError,
  type TaggedRow,
  type TaggedValue,
} from "./row-codec.js";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Prototype SQL encoding. Scale by exact powers of two instead of formatting a decimal REAL. */
function realBits(value: string): string {
  return `(CASE WHEN abs(${value}) > CAST('1.7976931348623157e308' AS REAL) THEN NULL ELSE (
    WITH RECURSIVE norm(x,e,s) AS (
      SELECT abs(${value}), 0, CASE WHEN atan2(${value},-1.0)<0 THEN 0x8000000000000000 ELSE 0 END
      UNION ALL
      SELECT CASE WHEN x>=2.0 THEN x/2.0 ELSE x*2.0 END,
             e + CASE WHEN x>=2.0 THEN 1 ELSE -1 END, s
      FROM norm WHERE x<>0.0 AND (x>=2.0 OR (x<1.0 AND e> -1022))
    )
    SELECT printf('%016llx',
      s |
      (CASE WHEN x=0.0 THEN 0
            WHEN x<1.0 THEN CAST(x*4503599627370496.0 AS INTEGER)
            ELSE ((e+1023)<<52) | CAST((x-1.0)*4503599627370496.0 AS INTEGER) END))
    FROM norm WHERE x=0.0 OR (x<2.0 AND (x>=1.0 OR e= -1022))
  ) END)`;
}
function capturedValue(value: string): string {
  return `CASE typeof(${value})
    WHEN 'null' THEN json_array('null')
    WHEN 'integer' THEN json_array('integer',CAST(${value} AS TEXT))
    WHEN 'real' THEN json_array('real',${realBits(value)})
    WHEN 'text' THEN json_array('text-utf8',lower(hex(CAST(${value} AS BLOB))))
    WHEN 'blob' THEN json_array('blob',lower(hex(${value}))) END`;
}

/** ASCII-only capture keeps invalid UTF-8 and embedded NUL out of driver string conversion. */
export function captureRowSql(columns: readonly string[], source?: "OLD" | "NEW"): string {
  return `json_object(${columns
    .map((name) => {
      const column = `${source ? `${source}.` : ""}${identifier(name)}`;
      return `'${name.replaceAll("'", "''")}',${capturedValue(column)}`;
    })
    .join(",")})`;
}

/** Normalize provisional capture inside the write transaction before publishing effects. */
export function decodeCapturedRow(json: string): TaggedRow {
  const row = JSON.parse(json) as Record<string, unknown>;
  if (row === null || typeof row !== "object" || Array.isArray(row))
    throw new RowEncodingError("Captured row must be an object");
  const columns = Object.entries(row).map(([column, value]) => {
    if (Array.isArray(value) && value[0] === "text-utf8") {
      if (value.length !== 2) throw new RowEncodingError("Invalid captured TEXT", column);
      const bytes = decodeStorageValue(["blob", value[1]]);
      if (bytes.type !== "blob") throw new RowEncodingError("Invalid captured TEXT", column);
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.value);
        return [column, parseTaggedValue(["text", text])];
      } catch {
        throw new RowEncodingError("Unsupported UTF-8 TEXT", column);
      }
    }
    return [column, value];
  });
  return parseTaggedRow(Object.fromEntries(columns));
}

export interface InstallationValue {
  readonly sql: string;
  readonly args: readonly (string | number | null | Uint8Array)[];
}

/** Avoid native numeric binding and decimal-to-REAL parsing, then verify installation by capture. */
export function installationValue(input: TaggedValue): InstallationValue {
  const tagged = parseTaggedValue(input);
  const value = decodeStorageValue(tagged);
  switch (value.type) {
    case "null":
      return { sql: "?", args: [null] };
    case "integer":
      return { sql: "CAST(? AS INTEGER)", args: [value.value.toString()] };
    case "text":
      return { sql: "?", args: [value.value] };
    case "blob":
      return { sql: "?", args: [value.value] };
    case "real": {
      const bits = BigInt(`0x${tagged[1]}`);
      const exponent = Number((bits >> 52n) & 0x7ffn);
      const fraction = bits & ((1n << 52n) - 1n);
      const mantissa = exponent === 0 ? fraction : fraction + (1n << 52n);
      if (mantissa === 0n)
        return { sql: "CAST(? AS REAL)", args: [bits >> 63n === 1n ? "-0.0" : "0.0"] };
      const scale = exponent === 0 ? (fraction === 0n ? 0 : -1074) : exponent - 1023 - 52;
      return {
        sql: `(WITH RECURSIVE scale(x,e) AS (
          SELECT CAST(CAST(? AS INTEGER) AS REAL), ?
          UNION ALL SELECT CASE WHEN e<0 THEN x/2.0 ELSE x*2.0 END,
            e + CASE WHEN e<0 THEN 1 ELSE -1 END FROM scale WHERE e<>0
        ) SELECT CASE WHEN ? THEN -x ELSE x END FROM scale WHERE e=0)`,
        args: [mantissa.toString(), scale, bits >> 63n === 1n ? 1 : 0],
      };
    }
  }
}

export function installationInsert(table: string, input: TaggedRow): InstallationValue {
  const row = parseTaggedRow(input);
  const columns = Object.keys(row);
  if (!columns.length) throw new RowEncodingError("Cannot install an empty row");
  const values = columns.map((column) => installationValue(row[column]));
  return {
    sql: `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(",")}) VALUES (${values.map((value) => value.sql).join(",")})`,
    args: values.flatMap((value) => [...value.args]),
  };
}
