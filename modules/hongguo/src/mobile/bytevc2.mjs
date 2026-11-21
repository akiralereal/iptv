import { AppError } from '../common.mjs';

export const BYTEVC2_HEADER_LIMIT = 1024 * 1024;
export const byteVC2Unsupported = () => new AppError('APP_BYTEVC2_UNSUPPORTED', '红果提供的 ByteVC2 片源无法在当前服务器播放');

function boxAt(buffer, start, end) {
  if (start + 8 > end || start + 8 > buffer.length) return null;
  const shortSize = buffer.readUInt32BE(start);
  const header = shortSize === 1 ? 16 : 8;
  if (start + header > buffer.length) return null;
  const size = shortSize === 1 ? Number(buffer.readBigUInt64BE(start + 8)) : shortSize || end - start;
  if (!Number.isSafeInteger(size) || size < header || size > end - start) throw byteVC2Unsupported();
  return { start, payload: start + header, end: start + size, type: buffer.toString('ascii', start + 4, start + 8) };
}

function* boxes(buffer, start, end) {
  while (start < end) {
    const box = boxAt(buffer, start, end);
    if (!box || box.end > buffer.length) throw byteVC2Unsupported();
    yield box;
    start = box.end;
  }
}

function child(buffer, parent, type) {
  if (!parent) return undefined;
  for (const box of boxes(buffer, parent.payload, parent.end)) if (box.type === type) return box;
}

function makePatches(buffer, moov) {
  const patches = [];
  for (const trak of boxes(buffer, moov.payload, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(buffer, trak, 'mdia');
    const minf = child(buffer, mdia, 'minf');
    const stbl = child(buffer, minf, 'stbl');
    const stsd = child(buffer, stbl, 'stsd');
    if (!stsd) continue;
    for (const entry of boxes(buffer, stsd.payload + 8, stsd.end)) {
      if (entry.type !== 'encv' && entry.type !== 'bvc2') continue;
      // Skip the fixed fields of VisualSampleEntry before reading child boxes.
      const description = { payload: entry.payload + 78, end: entry.end };
      const original = child(buffer, child(buffer, description, 'sinf'), 'frma');
      if (entry.type === 'encv' && (!original || original.end - original.payload !== 4
        || buffer.toString('ascii', original.payload, original.end) !== 'bvc2')) continue;
      const config = child(buffer, description, 'bv2C');
      const size = config && config.end - config.start;
      if (!config || size < 22 || child(buffer, description, 'vvcC')) throw byteVC2Unsupported();

      // The verified samples carry parameter sets in band and use four-byte
      // NAL lengths. Keep the original atom's footprint, so sample offsets,
      // encrypted packet bytes and every HTTP range remain valid.
      const replacement = Buffer.alloc(size);
      replacement.writeUInt32BE(14, 0);
      replacement.write('vvcC', 4);
      replacement[12] = 0xfe; // Reserved bits, lengthSizeMinusOne = 3, no PTL.
      replacement.writeUInt32BE(size - 14, 14);
      replacement.write('free', 18);
      patches.push({ offset: config.start, bytes: replacement });
      patches.push({ offset: original?.payload ?? entry.start + 4, bytes: Buffer.from('vvi1') });
    }
  }
  if (!patches.length) throw byteVC2Unsupported();
  return patches;
}

export async function readByteVC2Patches(body, size) {
  const buffer = Buffer.alloc(Math.min(BYTEVC2_HEADER_LIMIT, size));
  let length = 0, offset = 0;
  for await (const chunk of body) {
    const available = Math.min(chunk.length, buffer.length - length);
    buffer.set(chunk.subarray(0, available), length);
    length += available;
    const prefix = buffer.subarray(0, length);
    while (offset < length) {
      const box = boxAt(prefix, offset, size);
      if (!box || box.end > length) break;
      if (box.type === 'moov') return { patches: makePatches(buffer, box), bytesRead: length };
      offset = box.end;
    }
    if (length === buffer.length) break;
  }
  throw byteVC2Unsupported();
}

export function patchByteVC2Range(chunk, offset, patches) {
  let result = chunk;
  for (const patch of patches) {
    const from = Math.max(offset, patch.offset);
    const to = Math.min(offset + chunk.length, patch.offset + patch.bytes.length);
    if (from >= to) continue;
    if (result === chunk) result = Buffer.from(chunk);
    patch.bytes.copy(result, from - offset, from - patch.offset, to - patch.offset);
  }
  return result;
}
