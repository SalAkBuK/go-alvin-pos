import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZipArchive } from '../../src/main/support/zipArchive';

function readLocalEntries(archive: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    expect(method).toBe(8);
    result.set(name, inflateRawSync(compressed).toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return result;
}

describe('support ZIP archive', () => {
  it('creates a normal readable ZIP with flat entry names', () => {
    const archive = createZipArchive(
      [
        { name: 'support-info.json', content: Buffer.from('{"ok":true}') },
        { name: 'recent-app.log', content: Buffer.from('one\ntwo\n') },
      ],
      new Date('2026-09-12T12:00:00.000Z'),
    );
    expect(readLocalEntries(archive)).toEqual(
      new Map([
        ['support-info.json', '{"ok":true}'],
        ['recent-app.log', 'one\ntwo\n'],
      ]),
    );
    expect(archive.includes(Buffer.from('PK\u0005\u0006', 'binary'))).toBe(true);
  });

  it('rejects traversal, nested, absolute, and duplicate entry names', () => {
    for (const name of ['../escape', 'folder/file', 'folder\\file', 'C:\\file']) {
      expect(() => createZipArchive([{ name, content: Buffer.alloc(0) }], new Date())).toThrow(
        /unsafe/i,
      );
    }
    expect(() =>
      createZipArchive(
        [
          { name: 'safe.json', content: Buffer.alloc(0) },
          { name: 'SAFE.JSON', content: Buffer.alloc(0) },
        ],
        new Date(),
      ),
    ).toThrow(/duplicate/i);
  });
});
