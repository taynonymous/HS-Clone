import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrames } from '../src/ws.js';

function mask(frame) {
  // Re-encode a server frame as a masked client frame.
  const { frames } = decodeFrames(frame);
  const { opcode, payload } = frames[0];
  const key = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const hdr = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([hdr, key, body]);
}

test('frame round-trip across length encodings and partial buffers', () => {
  for (const n of [0, 5, 125, 126, 300, 70000]) {
    const text = 'x'.repeat(n);
    const f = encodeFrame(text);
    const { frames, rest } = decodeFrames(f);
    assert.equal(frames[0].payload.toString(), text);
    assert.equal(rest.length, 0);
    assert.equal(decodeFrames(f.subarray(0, f.length - 1)).frames.length, 0, 'incomplete frame is held back');
  }
});

test('decodes masked client frames, multiple per chunk', () => {
  const buf = Buffer.concat([mask(encodeFrame('ping')), mask(encodeFrame('a'.repeat(200)))]);
  const { frames } = decodeFrames(buf);
  assert.deepEqual(frames.map((f) => f.payload.toString().slice(0, 4)), ['ping', 'aaaa']);
});
