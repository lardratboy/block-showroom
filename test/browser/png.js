/* Minimal PNG reader and image summary, for render-modes.test.js: enough to
   turn a DevTools screenshot into numbers without a decoding dependency.
   8-bit truecolour (RGB/RGBA), non-interlaced, which is what Chrome's
   Page.captureScreenshot produces; zlib is built into Node. */
import { inflateSync } from 'node:zlib';

export function decodePNG(buf){
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < buf.length){
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR'){
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6))
    throw new Error(`unsupported PNG: depth=${depth} colour=${colour} interlace=${interlace}`);
  const bpp = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++){
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++){
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter){
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad PNG filter ' + filter);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

/* Summary of the 3D content: a centre crop (the HUD lives at the edges and
   carries figures that legitimately differ between builds), the mean colour,
   how much of it is lit at all, and a coarse RGB histogram of the lit pixels
   so a colouring change shows up even when the pixel count does not. */
export function imageStats(img, { x0 = 0.26, x1 = 0.74, y0 = 0.18, y1 = 0.82, lit = 46 } = {}){
  const { width, height, bpp, data } = img;
  const ix0 = Math.floor(width * x0), ix1 = Math.floor(width * x1);
  const iy0 = Math.floor(height * y0), iy1 = Math.floor(height * y1);
  const hist = new Float64Array(64);
  let n = 0, litN = 0, sr = 0, sg = 0, sb = 0, lr = 0, lg = 0, lb = 0;
  for (let y = iy0; y < iy1; y++){
    for (let x = ix0; x < ix1; x++){
      const o = (y * width + x) * bpp;
      const r = data[o], g = data[o+1], b = data[o+2];
      n++; sr += r; sg += g; sb += b;
      if (r + g + b > lit * 3){
        litN++; lr += r; lg += g; lb += b;
        hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++;
      }
    }
  }
  for (let i = 0; i < 64; i++) hist[i] /= Math.max(1, litN);
  return {
    pixels: n, litFraction: +(litN / n).toFixed(5),
    mean: [+(sr/n).toFixed(3), +(sg/n).toFixed(3), +(sb/n).toFixed(3)],
    litMean: litN ? [+(lr/litN).toFixed(3), +(lg/litN).toFixed(3), +(lb/litN).toFixed(3)] : [0,0,0],
    hist: Array.from(hist, v => +v.toFixed(5))
  };
}

/* L1 distance between two normalised histograms: 0 identical, 2 disjoint. */
export function histL1(a, b){
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}
