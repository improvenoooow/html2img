// helpers: bezier sampling, tubes (variable width strokes) and smooth closed paths
const f = n => (Math.round(n * 10) / 10).toString();
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
          u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]];
}
// sample a poly-cubic given as [p0, c1, c2, p1, c1, c2, p2 ...]
function samplePath(pts, nPer = 40) {
  const out = [];
  for (let i = 0; i + 3 < pts.length; i += 3)
    for (let k = (i ? 1 : 0); k <= nPer; k++) out.push(cubic(pts[i], pts[i+1], pts[i+2], pts[i+3], k / nPer));
  return out;
}
// Catmull-Rom -> cubic bezier for a list of points
function smooth(points, closed = false, tension = 1) {
  const n = points.length, P = i => closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))];
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6 * tension, p1[1] + (p2[1] - p0[1]) / 6 * tension];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6 * tension, p2[1] - (p3[1] - p1[1]) / 6 * tension];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + (closed ? 'Z' : '');
}
// tube: centerline (poly-cubic control points), width function w(t), rounded end cap
function tube(ctrl, w, { cap = 'round', n = 40, step = 4 } = {}) {
  const s = samplePath(ctrl, n);
  const L = [], R = [];
  for (let i = 0; i < s.length; i++) {
    const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const t = i / (s.length - 1), hw = w(t) / 2;
    L.push([s[i][0] - dy * hw, s[i][1] + dx * hw]);
    R.push([s[i][0] + dy * hw, s[i][1] - dx * hw]);
  }
  const pick = arr => arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
  const Ls = pick(L), Rs = pick(R).reverse();
  // end cap: semicircle around last point
  const e = s[s.length - 1], pe = s[s.length - 2];
  let dx = e[0] - pe[0], dy = e[1] - pe[1]; const l = Math.hypot(dx, dy); dx /= l; dy /= l;
  const hw = w(1) / 2, capPts = [];
  if (cap === 'round') for (let k = 1; k < 8; k++) {
    const ang = Math.PI * k / 8; // from L side around the tip to R side
    const nx = -dy, ny = dx; // L normal
    capPts.push([e[0] + (nx * Math.cos(ang) + dx * Math.sin(ang)) * hw, e[1] + (ny * Math.cos(ang) + dy * Math.sin(ang)) * hw]);
  }
  return smooth([...Ls, ...capPts, ...Rs], true, 0.9);
}
module.exports = { f, cubic, samplePath, smooth, tube };
