// C2 — ilustracja z płaskimi cieniami (cel-shading, twarde cienie, bez gradientów)
const G = require('./geo'); const fs = require('fs');
const B = G.boxes2;
let id = 0;
// shape with hard shadow crescent (light from top-left) + thin highlight crescent
function cel(d, base, shade, hi, sh = [-20, -22], hl = [7, 8]) {
  const k = id++;
  return `<clipPath id="c${k}"><path d="${d}"/></clipPath>
  <path d="${d}" fill="${shade}"/>
  <g clip-path="url(#c${k})"><path d="${d}" fill="${base}" transform="translate(${sh[0]} ${sh[1]})"/>
  ${hi ? `<g><path d="${d}" fill="${hi}"/><path d="${d}" fill="${base}" transform="translate(${hl[0]} ${hl[1]})"/></g>` : ''}</g>`;
}
// note: highlight layer must sit under shadow region; build order: hi -> base(shifted) -> shade(shifted opposite)
function cel2(d, base, shade, hi, s = 22, h = 8) {
  const k = id++;
  return `<clipPath id="c${k}"><path d="${d}"/></clipPath>
  <g clip-path="url(#c${k})">
   <path d="${d}" fill="${hi}"/>
   <path d="${d}" fill="${base}" transform="translate(${h} ${h * 1.1})"/>
   <path d="M-2000 -2000 H4000 V4000 H-2000Z M${0} 0" fill="none"/>
   <g transform="translate(${-s} ${-s * 1.1})"><path d="${d}" fill="none"/></g>
  </g>`;
}
const P = { bg: '#FF7A59', cream: '#F6F1EC', plum: '#3B2C5E', plumD: '#2A1F45', plumL: '#5A4787', coral: '#FF7A59', coralD: '#E0583A', kraft: '#E3AC68', kraftD: '#C48644', kraftL: '#F3CD93', ink: '#1E1533' };
// shadow mask approach: base fill, then shade = part minus (part shifted up-left)
function shaded(d, base, shade, hi, s = [22, 24], h = [9, 10]) {
  const k = id++;
  return `<clipPath id="c${k}"><path d="${d}"/></clipPath>
  <mask id="m${k}" maskUnits="userSpaceOnUse" x="-500" y="-500" width="2500" height="2500"><rect x="-500" y="-500" width="2500" height="2500" fill="#fff"/><path d="${d}" fill="#000" transform="translate(${-s[0]} ${-s[1]})"/></mask>
  <mask id="h${k}" maskUnits="userSpaceOnUse" x="-500" y="-500" width="2500" height="2500"><rect x="-500" y="-500" width="2500" height="2500" fill="#fff"/><path d="${d}" fill="#000" transform="translate(${h[0]} ${h[1]})"/></mask>
  <path d="${d}" fill="${base}"/>
  <g clip-path="url(#c${k})">${hi ? `<path d="${d}" fill="${hi}" mask="url(#h${k})"/>` : ''}<path d="${d}" fill="${shade}" mask="url(#m${k})"/></g>`;
}
const boxSvg = b => `<g transform="${b.tr}">
  <path d="${b.side}" fill="${P.kraftD}"/>
  <path d="${b.top}" fill="${P.kraftL}"/>
  ${shaded(b.front, P.kraft, '#D49650', null, [0, 18])}
  <path d="${b.seam}" stroke="${P.kraftD}" stroke-width="4" stroke-linecap="round"/>
  <path d="${b.tapeTop}" fill="#FF9877"/><path d="${b.tapeFront}" fill="${P.coral}"/>
  <path d="${b.tapeFront}" fill="${P.coralD}" transform="translate(0 0)" clip-path="none" opacity="0"/>
  <path d="${b.handle}" fill="${P.ink}"/>
</g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" fill="${P.bg}"/>
<circle cx="512" cy="512" r="372" fill="#FF8A6B"/>
<g transform="${G.T}">
 <path d="M330 838 Q600 822 880 838 Q600 852 330 838Z" fill="#D9573A"/>
 ${shaded(G.tail, P.plum, P.plumD)}<path d="${G.tuft}" fill="${P.plumD}"/>
 ${shaded(G.legHindFar, P.plumD, '#21183A')}${shaded(G.legFrontFar, P.plumD, '#21183A')}
 ${shaded(G.legHindNear, P.plum, P.plumD, P.plumL, [22, 10], [5, 4])}${shaded(G.legFrontNear, P.plum, P.plumD, P.plumL, [22, 10], [5, 4])}
 ${shaded(G.body, P.plum, P.plumD, P.plumL, [26, 30], [10, 12])}
 ${shaded(G.trunk, P.plum, P.plumD, P.plumL, [20, 22], [8, 8])}
 ${shaded(G.head, P.plum, P.plumD, P.plumL, [26, 30], [10, 12])}
 <path d="${G.nailsFN}${G.nailsHN}" fill="${P.cream}" transform="translate(0 -5)"/><path d="${G.nailsFF}${G.nailsHF}" fill="${P.plumL}" transform="translate(0 -5)"/>
 <path d="M820 660 q24 7 44 0 M818 690 q22 6 40 0" stroke="${P.plumD}" stroke-width="6" stroke-linecap="round" fill="none"/>
 <path d="${G.ear}" fill="${P.plumD}" transform="translate(8 10)"/>
 ${shaded(G.ear, P.plumL, P.plum, '#7461A6', [18, 20], [8, 8])}
 ${shaded(G.earInner, P.coral, P.coralD, '#FF9C80', [14, 16], [6, 6])}
 <ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="16" ry="20" fill="${P.ink}"/>
 <circle cx="${G.eye.cx - 4}" cy="${G.eye.cy - 7}" r="6" fill="${P.cream}"/>
 <path d="M744 470 q22 -14 48 -4" stroke="${P.plumD}" stroke-width="7" fill="none" stroke-linecap="round"/>
 <ellipse cx="800" cy="590" rx="22" ry="12" fill="${P.coral}" opacity=".7"/>
 <path d="${G.mouth}" stroke="${P.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>
 <path d="M340 482 Q470 466 600 478 L600 498 Q470 488 340 504Z" fill="${P.plumD}"/>
 ${B.map(boxSvg).join('')}
</g></svg>`;
fs.writeFileSync('c2.svg', svg);
