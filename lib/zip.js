// lib/zip.js — minimal streaming ZIP writer (deflate + store).
// Replaces shelling out to PowerShell's Compress-Archive, which interpolated the
// folder path into a command string (injectable via a crafted folder name) and
// fails outright when execution policy or PowerShell itself is locked down.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ZIP stores timestamps in the 1980-based MS-DOS format.
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const deflate = buf => new Promise((resolve, reject) =>
  zlib.deflateRaw(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));

async function walk(root, rel = '', out = []) {
  for (const entry of await fs.promises.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip .sitesnap undo snapshots etc.
    const next = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) await walk(root, next, out);
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

/**
 * Zip a folder's contents (no wrapping root folder inside the archive).
 * @param {string} sourceDir folder to archive
 * @param {string} zipPath   output .zip path
 * @param {(done:number,total:number,name:string)=>void} [onProgress]
 */
async function zipFolder(sourceDir, zipPath, onProgress = () => {}) {
  const names = await walk(sourceDir);
  if (!names.length) throw new Error('Nothing to zip — the folder is empty.');

  const out = fs.createWriteStream(zipPath);
  const failure = new Promise((_, reject) => out.once('error', reject));
  const write = chunk => Promise.race([
    new Promise((resolve, reject) => out.write(chunk, err => (err ? reject(err) : resolve()))),
    failure,
  ]);

  const central = [];
  let offset = 0;

  try {
    for (let i = 0; i < names.length; i++) {
      const rel = names[i];
      const abs = path.join(sourceDir, rel);
      const [data, stat] = await Promise.all([fs.promises.readFile(abs), fs.promises.stat(abs)]);
      if (data.length > 0xFFFFFFFF) throw new Error(`File too large for a plain ZIP: ${rel}`);

      let method = 8;
      let body = await deflate(data);
      if (body.length >= data.length) { method = 0; body = data; }  // don't inflate incompressible files

      const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
      const { time, date } = dosDateTime(stat.mtime);
      const crc = crc32(data);

      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034B50, 0);
      local.writeUInt16LE(20, 4);          // version needed
      local.writeUInt16LE(0x0800, 6);      // flag: UTF-8 filename
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      name.copy(local, 30);

      await write(local);
      await write(body);
      central.push({ name, method, time, date, crc, compressed: body.length, size: data.length, offset });
      offset += local.length + body.length;
      if (offset > 0xFFFFFFFF) throw new Error('Archive would exceed the 4 GB ZIP limit.');
      onProgress(i + 1, names.length, rel);
    }

    const centralStart = offset;
    for (const e of central) {
      const header = Buffer.alloc(46 + e.name.length);
      header.writeUInt32LE(0x02014B50, 0);
      header.writeUInt16LE(20, 4);         // version made by
      header.writeUInt16LE(20, 6);         // version needed
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(e.method, 10);
      header.writeUInt16LE(e.time, 12);
      header.writeUInt16LE(e.date, 14);
      header.writeUInt32LE(e.crc, 16);
      header.writeUInt32LE(e.compressed, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt32LE(e.offset, 42);
      e.name.copy(header, 46);
      await write(header);
      offset += header.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    await write(eocd);

    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    return { files: central.length, bytes: offset };
  } catch (err) {
    out.destroy();
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { zipFolder, crc32 };
