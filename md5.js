(function initializeMd5(globalScope) {
  const SHIFT_AMOUNTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const ROUND_CONSTANTS = Array.from({ length: 64 }, (_, index) => {
    return Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0;
  });

  function md5Hex(value) {
    const bytes = encodeUtf8(String(value));
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    const bitLengthLow = (bytes.length * 8) >>> 0;
    const bitLengthHigh = Math.floor(bytes.length / 0x20000000) >>> 0;
    writeUint32LittleEndian(padded, paddedLength - 8, bitLengthLow);
    writeUint32LittleEndian(padded, paddedLength - 4, bitLengthHigh);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < padded.length; offset += 64) {
      const words = new Uint32Array(16);

      for (let index = 0; index < 16; index += 1) {
        words[index] = readUint32LittleEndian(padded, offset + (index * 4));
      }

      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;

      for (let index = 0; index < 64; index += 1) {
        let mixed;
        let wordIndex;

        if (index < 16) {
          mixed = (b & c) | ((~b) & d);
          wordIndex = index;
        } else if (index < 32) {
          mixed = (d & b) | ((~d) & c);
          wordIndex = ((5 * index) + 1) % 16;
        } else if (index < 48) {
          mixed = b ^ c ^ d;
          wordIndex = ((3 * index) + 5) % 16;
        } else {
          mixed = c ^ (b | (~d));
          wordIndex = (7 * index) % 16;
        }

        const nextD = c;
        const nextC = b;
        const sum = addUnsigned(a, mixed, ROUND_CONSTANTS[index], words[wordIndex]);
        const nextB = (b + rotateLeft(sum, SHIFT_AMOUNTS[index])) >>> 0;
        a = d;
        b = nextB;
        c = nextC;
        d = nextD;
      }

      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0].map(toLittleEndianHex).join("");
  }

  function encodeUtf8(value) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(value);
    }

    const bytes = [];

    for (const character of value) {
      const codePoint = character.codePointAt(0);

      if (codePoint <= 0x7f) {
        bytes.push(codePoint);
      } else if (codePoint <= 0x7ff) {
        bytes.push(
          0xc0 | (codePoint >>> 6),
          0x80 | (codePoint & 0x3f)
        );
      } else if (codePoint <= 0xffff) {
        bytes.push(
          0xe0 | (codePoint >>> 12),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >>> 18),
          0x80 | ((codePoint >>> 12) & 0x3f),
          0x80 | ((codePoint >>> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }

    return Uint8Array.from(bytes);
  }

  function readUint32LittleEndian(bytes, offset) {
    return (bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24)) >>> 0;
  }

  function writeUint32LittleEndian(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function addUnsigned(...values) {
    return values.reduce((sum, value) => (sum + (value >>> 0)) >>> 0, 0);
  }

  function rotateLeft(value, amount) {
    return ((value << amount) | (value >>> (32 - amount))) >>> 0;
  }

  function toLittleEndianHex(value) {
    let result = "";

    for (let index = 0; index < 4; index += 1) {
      result += ((value >>> (index * 8)) & 0xff).toString(16).padStart(2, "0");
    }

    return result;
  }

  globalScope.md5Module = Object.freeze({ md5Hex });
  globalScope.md5Hex = md5Hex;
})(self);
