// Minimal, dependency-free ZIP writer (STORE method, UTF-8 file names).
// Good enough for source code projects; no compression needed.
const DSZip = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /**
   * @param {{path:string, content?:string, dir?:boolean}[]} entries
   * @returns {Blob}
   */
  function build(entries) {
    const enc = new TextEncoder();
    const now = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const isDir = !!e.dir;
      const path = isDir && !e.path.endsWith("/") ? e.path + "/" : e.path;
      const name = enc.encode(path);
      const data = isDir ? new Uint8Array(0) : enc.encode(e.content ?? "");
      const crc = isDir ? 0 : crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true); // store
      lh.setUint16(10, now.time, true);
      lh.setUint16(12, now.date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, now.time, true);
      ch.setUint16(14, now.date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, isDir ? 0x10 : 0, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + data.length;
    }

    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  /**
   * Reads a ZIP (stored or deflated) using the browser's built-in DecompressionStream.
   * @param {ArrayBuffer} buf
   * @returns {Promise<{path:string, dir:boolean, bytes?:Uint8Array, error?:string}[]>}
   */
  async function read(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid ZIP file.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error("ZIP64 archives are not supported.");

    const utf8 = new TextDecoder("utf-8");
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const path = utf8.decode(u8.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, "/");
      p += 46 + nlen + elen + clen;

      if (path.endsWith("/")) { out.push({ path, dir: true }); continue; }
      if (flags & 1) { out.push({ path, dir: false, error: "encrypted" }); continue; }

      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + csize);
      try {
        let bytes;
        if (method === 0) bytes = data.slice();
        else if (method === 8) {
          const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else { out.push({ path, dir: false, error: `compression method ${method}` }); continue; }
        out.push({ path, dir: false, bytes });
      } catch (e) {
        out.push({ path, dir: false, error: "could not decompress" });
      }
    }
    return out;
  }

  return { build, read, crc32 };
})();

if (typeof module !== "undefined") module.exports = DSZip;
