/**
 * Butterfly locator used by the verification harness.
 *
 * Finds the butterfly's saturated blue wing pixels and reports their centroid
 * as a fraction of frame size. Used to assert that a click actually moves the
 * butterfly toward the clicked region rather than only re-centring it.
 *
 * Usage (CLI): node tools/butterfly-centroid.mjs <img1.png> [img2.png ...]
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/** Minimal PNG decoder for 8-bit RGBA/RGB non-interlaced images. */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    offset += length + 12;
  }
  if (bitDepth !== 8) throw new Error("only 8-bit PNG supported");

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error("unsupported colour type " + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const rawByte = line[x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("bad filter " + filter);
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Locates the butterfly in a PNG buffer.
 * @returns {count, cx, cy, width, height} with cx/cy in pixels, or count 0.
 */
export function findButterfly(buffer) {
  const { width, height, channels, data } = decodePng(buffer);
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width * channels + x * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Butterfly wings: saturated blue, clearly separated from the pale scene
      // and from the desktop's transparent background.
      if (b > 110 && b - r > 45 && b - g > 25) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  return {
    count,
    width,
    height,
    cx: count ? sumX / count : 0,
    cy: count ? sumY / count : 0,
  };
}

// CLI mode: report centroids for the given image files. Both sides are
// normalised to forward slashes, since argv keeps the platform separators.
const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");

if (invokedDirectly) {
  for (const file of process.argv.slice(2)) {
    const result = findButterfly(readFileSync(file));
    const name = file.split(/[\\/]/).pop();
    if (!result.count) {
      console.log(`${name}: butterfly not found`);
      continue;
    }
    console.log(
      `${name}: pixels=${result.count} centroid=(${(result.cx / result.width).toFixed(3)}, ` +
        `${(result.cy / result.height).toFixed(3)})`,
    );
  }
}
