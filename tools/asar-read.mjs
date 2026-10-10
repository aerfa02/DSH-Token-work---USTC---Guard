// Read-only ASAR reader; no system repair or installation.
export function archiveOf(bytes) {
  const dataStart = 8 + bytes.readUInt32LE(4);
  const table = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
  const entry = path => path.split('/').filter(Boolean).reduce((node, name) => node?.files?.[name], table);
  const read = path => {
    const node = entry(path);
    if (!node || node.unpacked || node.link || !Number.isSafeInteger(node.size)) throw new Error('Not a packed file: ' + path);
    const start = dataStart + Number(node.offset);
    if (start < dataStart || start + node.size > bytes.length) throw new Error('Archive bounds: ' + path);
    return bytes.subarray(start, start + node.size);
  };
  return { table, dataStart, entry, read };
}
