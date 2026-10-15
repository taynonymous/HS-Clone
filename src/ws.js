// Minimal RFC 6455 server: text frames out, ping/pong/close in. Enough for
// pushing alerts to the Chrome extension (MV3 service workers stay alive while
// WebSocket traffic flows; SSE/EventSource is not available to them).
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_INBOUND = 64 * 1024;

export function encodeFrame(data, opcode = OP.TEXT) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Yields complete frames from buf; returns { frames, rest }.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskEnd = pos + (masked ? 4 : 0);
    if (buf.length < maskEnd + len) break;
    const payload = Buffer.from(buf.subarray(maskEnd, maskEnd + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[pos + (i & 3)];
    frames.push({ opcode: b0 & 0x0f, payload });
    off = maskEnd + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return null;
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  let pending = Buffer.alloc(0);
  let closed = false;
  const conn = {
    send(text) {
      if (!closed && socket.writable) socket.write(encodeFrame(text));
    },
    close() {
      if (closed) return;
      closed = true;
      if (socket.writable) socket.end(encodeFrame(Buffer.alloc(0), OP.CLOSE));
      else socket.destroy();
    },
    onclose: null,
  };

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_INBOUND) return conn.close();
    const { frames, rest } = decodeFrames(pending);
    pending = Buffer.from(rest);
    for (const f of frames) {
      if (f.opcode === OP.PING) socket.write(encodeFrame(f.payload, OP.PONG));
      else if (f.opcode === OP.CLOSE) conn.close();
      // client text frames (keepalives) are ignored
    }
  });
  const done = () => {
    closed = true;
    conn.onclose?.();
  };
  socket.on('close', done);
  socket.on('error', () => socket.destroy());
  return conn;
}
