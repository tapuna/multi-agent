/** Firebird's public DSQL ABI, via prebuilt Koffi. No wire server or build toolchain. */
import koffi from "koffi";
import fs from "node:fs";
import path from "node:path";
import { DATA, HttpError } from "./config.js";

const library =
  process.env.FIREBIRD_CLIENT_LIBRARY ||
  path.join(
    process.env.FIREBIRD_RUNTIME_DIR || path.join(DATA, "firebird-runtime"),
    process.platform === "win32" ? "fbclient.dll" : "lib/libfbclient.so",
  );
let lib: ReturnType<typeof koffi.load>;
function native() {
  return (lib ||= koffi.load(library));
}
const functions = new Map<string, any>();
// SQLDA holds raw addresses; retain backing buffers until the statement is disposed.
const pinned = new Set<Buffer[]>();
function fn(name: string, args: string[]) {
  let f = functions.get(name);
  if (!f) {
    f = native().func(name, "intptr", args);
    functions.set(name, f);
  }
  return f;
}
async function call(
  name: string,
  args: string[],
  values: any[],
  allowed: number[] = [],
): Promise<number> {
  const status = Buffer.alloc(20 * 8);
  const result = Number(
    await new Promise((resolve, reject) =>
      fn(name, ["void *", ...args]).async(
        status,
        ...values,
        (err: any, result: any) => (err ? reject(err) : resolve(result)),
      ),
    ),
  );
  if (result && !allowed.includes(result)) {
    const sqlcode = native().func("isc_sqlcode", "int32", ["void *"])(status);
    const ptr = Buffer.alloc(8);
    koffi.encode(ptr, "void *", status);
    const out = Buffer.alloc(2048);
    const interpret = native().func("fb_interpret", "int32", [
      "void *",
      "uint32",
      "void *",
    ]);
    const messages: string[] = [];
    while (interpret(out, out.length, ptr))
      messages.push(
        out.toString(
          "utf8",
          0,
          out.indexOf(0) >= 0 ? out.indexOf(0) : out.length,
        ),
      );
    const e = new HttpError(
      sqlcode === -913 ? 409 : [-803, -530, -625].includes(sqlcode) ? 409 : 500,
      sqlcode === -913
        ? "Another transaction holds this record. Refresh and retry shortly."
        : messages.join("; "),
      sqlcode === -913 ? "database_busy" : undefined,
    );
    throw e;
  }
  return result;
}
function sqlda(n = 128) {
  const b = Buffer.alloc(24 + 160 * n);
  b.writeInt16LE(1, 0);
  b.writeInt32LE(b.length, 12);
  b.writeInt16LE(n, 16);
  return b;
}
type Field = {
  offset: number;
  type: number;
  scale: number;
  len: number;
  name: string;
  data: Buffer;
  indicator: Buffer;
};
function fields(desc: Buffer): Field[] {
  const n = desc.readInt16LE(18);
  if (n > desc.readInt16LE(16)) throw new Error("Too many SQL columns");
  return Array.from({ length: n }, (_, i) => {
    const o = 24 + i * 160,
      type = desc.readInt16LE(o) & ~1,
      len = desc.readInt16LE(o + 6);
    const data = Buffer.alloc(Math.max(len + 2, 16)),
      indicator = Buffer.alloc(2);
    koffi.encode(desc, o + 8, "void *", data);
    koffi.encode(desc, o + 16, "void *", indicator);
    return {
      offset: o,
      type,
      len,
      scale: desc.readInt16LE(o + 2),
      name: desc
        .toString("utf8", o + 128, o + 128 + desc.readInt16LE(o + 126))
        .trim()
        .toLowerCase(),
      data,
      indicator,
    };
  });
}
export class Firebird {
  handle = Buffer.alloc(8);
  transaction = Buffer.alloc(8);
  static async open(filename: string, create = false) {
    if (process.arch !== "x64")
      throw new Error("Embedded driver currently requires x64 Node.js");
    const db = new Firebird();
    const param = (id: number, s: string) =>
      Buffer.concat([Buffer.from([id, Buffer.byteLength(s)]), Buffer.from(s)]);
    const dpb = Buffer.concat([
      Buffer.from([1]),
      param(28, process.env.FIREBIRD_USER || "SYSDBA"),
      param(48, "UTF8"),
      ...(process.env.FIREBIRD_PASSWORD
        ? [param(29, process.env.FIREBIRD_PASSWORD)]
        : []),
      Buffer.from([63, 4, 3, 0, 0, 0]),
    ]);
    if (!fs.existsSync(library))
      throw new Error(
        "Firebird runtime missing. Run npm run setup:firebird or set FIREBIRD_CLIENT_LIBRARY.",
      );
    await call(
      create ? "isc_create_database" : "isc_attach_database",
      [
        "int16",
        "str",
        "void *",
        "int16",
        "void *",
        ...(create ? ["int16"] : []),
      ],
      [
        Buffer.byteLength(filename),
        filename,
        db.handle,
        dpb.length,
        dpb,
        ...(create ? [3] : []),
      ],
    );
    return db;
  }
  async begin() {
    const timeout = Number(process.env.FIREBIRD_LOCK_TIMEOUT_SECONDS || 5);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10)
      throw new Error("FIREBIRD_LOCK_TIMEOUT_SECONDS must be 1..10");
    const tpb = Buffer.from([3, 15, 17, 6, 9, 21, 4, timeout, 0, 0, 0]);
    await call(
      "isc_start_transaction",
      ["void *", "int16", "void *", "uint16", "void *"],
      [this.transaction, 1, this.handle, tpb.length, tpb],
    );
  }
  async finish(commit = true) {
    if (this.transaction.some((x) => x))
      await call(
        commit ? "isc_commit_transaction" : "isc_rollback_transaction",
        ["void *"],
        [this.transaction],
      );
  }
  async close() {
    if (this.handle.some((x) => x))
      await call("isc_detach_database", ["void *"], [this.handle]);
  }
  async blob(data: Buffer) {
    const handle = Buffer.alloc(8),
      id = Buffer.alloc(8);
    await call(
      "isc_create_blob2",
      ["void *", "void *", "void *", "void *", "int16", "void *"],
      [this.handle, this.transaction, handle, id, 0, null],
    );
    try {
      for (let n = 0; n < data.length; n += 32000) {
        const part = data.subarray(n, n + 32000);
        await call(
          "isc_put_segment",
          ["void *", "uint16", "void *"],
          [handle, part.length, part],
        );
      }
    } finally {
      await call("isc_close_blob", ["void *"], [handle]);
    }
    return id;
  }
  async readBlob(id: Buffer) {
    const handle = Buffer.alloc(8);
    await call(
      "isc_open_blob2",
      ["void *", "void *", "void *", "void *", "int16", "void *"],
      [this.handle, this.transaction, handle, id, 0, null],
    );
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const data = Buffer.alloc(32000),
          len = Buffer.alloc(2);
        const r = await call(
          "isc_get_segment",
          ["void *", "void *", "uint16", "void *"],
          [handle, len, data.length, data],
          [335544366, 335544367],
        );
        if (r === 335544367) break;
        size += len.readUInt16LE();
        if (size > 8 * 1024 * 1024)
          throw new Error("Database document exceeds 8 MiB");
        chunks.push(data.subarray(0, len.readUInt16LE()));
      }
    } finally {
      await call("isc_close_blob", ["void *"], [handle]);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, any>[]> {
    const statement = Buffer.alloc(8),
      output = sqlda();
    await call(
      "isc_dsql_allocate_statement",
      ["void *", "void *"],
      [this.handle, statement],
    );
    const retained: Buffer[] = [];
    pinned.add(retained);
    try {
      await call(
        "isc_dsql_prepare",
        ["void *", "void *", "uint16", "str", "uint16", "void *"],
        [this.transaction, statement, 0, sql, 3, output],
      );
      let input: Buffer | null = null;
      if (params.length) {
        input = sqlda();
        await call(
          "isc_dsql_describe_bind",
          ["void *", "uint16", "void *"],
          [statement, 3, input],
        );
        const vars = fields(input);
        if (vars.length !== params.length)
          throw new Error("SQL bind count mismatch");
        for (let i = 0; i < vars.length; i++) {
          const f = vars[i],
            v = params[i];
          retained.push(f.data, f.indicator);
          if (v === null || v === undefined) {
            f.indicator.writeInt16LE(-1);
            continue;
          }
          if (f.type === 520) {
            const text = typeof v === "string" ? v : JSON.stringify(v);
            (await this.blob(Buffer.from(text))).copy(f.data);
          } else {
            const text =
              typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
            const bytes = Buffer.from(text);
            if (bytes.length > 32760)
              throw new Error("SQL parameter exceeds varchar limit");
            const data = Buffer.alloc(bytes.length + 2);
            data.writeUInt16LE(bytes.length);
            bytes.copy(data, 2);
            input.writeInt16LE(449, f.offset);
            input.writeInt16LE(bytes.length, f.offset + 6);
            koffi.encode(input, f.offset + 8, "void *", data);
            retained.push(data);
          }
        }
      }
      const cols = fields(output);
      retained.push(...cols.flatMap((c) => [c.data, c.indicator]));
      const singleton = cols.length > 0 && !/^\s*(SELECT|WITH)\b/i.test(sql);
      if (singleton)
        await call(
          "isc_dsql_execute2",
          ["void *", "void *", "uint16", "void *", "void *"],
          [this.transaction, statement, 3, input, output],
        );
      else
        await call(
          "isc_dsql_execute",
          ["void *", "void *", "uint16", "void *"],
          [this.transaction, statement, 3, input],
        );
      const result: Record<string, any>[] = [];
      if (cols.length)
        for (;;) {
          if (!singleton) {
            const code = await call(
              "isc_dsql_fetch",
              ["void *", "uint16", "void *"],
              [statement, 3, output],
              [100],
            );
            if (code === 100) break;
          }
          const row: Record<string, any> = {};
          for (const c of cols) {
            let v: any = null;
            const b = c.data;
            if (c.indicator.readInt16LE() !== -1) {
              switch (c.type) {
                case 452:
                  v = b.toString("utf8", 0, c.len).trimEnd();
                  break;
                case 448:
                  v = b.toString("utf8", 2, 2 + b.readUInt16LE());
                  break;
                case 500:
                  v = b.readInt16LE();
                  break;
                case 496:
                  v = b.readInt32LE();
                  break;
                case 580:
                  v = Number(b.readBigInt64LE());
                  break;
                case 480:
                case 530:
                  v = b.readDoubleLE();
                  break;
                case 482:
                  v = b.readFloatLE();
                  break;
                case 32764:
                  v = !!b[0];
                  break;
                case 520:
                  v = await this.readBlob(b);
                  break;
                case 510:
                case 32754: {
                  const epoch =
                    Date.UTC(1858, 10, 17) +
                    b.readInt32LE() * 86400000 +
                    b.readUInt32LE(4) / 10;
                  v = new Date(epoch).toISOString();
                  break;
                }
                case 570:
                  v = new Date(
                    Date.UTC(1858, 10, 17) + b.readInt32LE() * 86400000,
                  ).toISOString();
                  break;
                default:
                  throw new Error("Unsupported SQL type " + c.type);
              }
              if (c.scale && typeof v === "number") v *= 10 ** c.scale;
            }
            row[c.name] = v;
          }
          result.push(row);
          if (singleton) break;
          if (result.length > 10000)
            throw new Error("Query row limit exceeded");
        }
      return result;
    } finally {
      try {
        await call(
          "isc_dsql_free_statement",
          ["void *", "uint16"],
          [statement, 2],
        );
      } finally {
        pinned.delete(retained);
      }
    }
  }
}
