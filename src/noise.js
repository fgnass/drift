// 3D simplex noise (Stefan Gustavson's algorithm), returns about -1 to 1.
// Seeded per page load so every night looks a little different.

const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
const F3 = 1 / 3;
const G3 = 1 / 6;

const perm = new Uint8Array(512);
const permMod12 = new Uint8Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
}

function corner(t, g, x, y, z) {
  if (t < 0) return 0;
  t *= t;
  return t * t * (g[0] * x + g[1] * y + g[2] * z);
}

export function simplex3(xin, yin, zin) {
  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const k = Math.floor(zin + s);
  const t = (i + j + k) * G3;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const z0 = zin - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  const g0 = GRAD[permMod12[ii + perm[jj + perm[kk]]]];
  const g1 = GRAD[permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]];
  const g2 = GRAD[permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]];
  const g3 = GRAD[permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]];
  return (
    32 *
    (corner(0.6 - x0 * x0 - y0 * y0 - z0 * z0, g0, x0, y0, z0) +
      corner(0.6 - x1 * x1 - y1 * y1 - z1 * z1, g1, x1, y1, z1) +
      corner(0.6 - x2 * x2 - y2 * y2 - z2 * z2, g2, x2, y2, z2) +
      corner(0.6 - x3 * x3 - y3 * y3 - z3 * z3, g3, x3, y3, z3))
  );
}
