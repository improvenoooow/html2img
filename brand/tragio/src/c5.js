// C5 — gruba linia z wypełnieniem (styl naklejki): jedna grubość konturu, płaskie wypełnienia + twardy cień wewnętrzny
const G = require('./geo'); const fs = require('fs');
const B = G.boxes2;
const P = { bg: '#FFB49E', line: '#33254F', el: '#F1EBFA', elSh: '#D9CDF0', far: '#B9A9DF', coral: '#FF7A59', coralD: '#E65F3F', kraft: '#E8B26E', kraftSh: '#D59650', kraftT: '#F6D29E', kraftS: '#C27F3C' };
const W = 17;
let k = 0;
function part(d, fill, sh, s = [18, 20], w = W) {
  const i = k++;
  return `<clipPath id="k${i}"><path d="${d}"/></clipPath>
  <mask id="q${i}" maskUnits="userSpaceOnUse" x="-500" y="-500" width="2500" height="2500"><rect x="-500" y="-500" width="2500" height="2500" fill="#fff"/><path d="${d}" fill="#000" transform="translate(${-s[0]} ${-s[1]})"/></mask>
  <path d="${d}" fill="${fill}"/>${sh ? `<g clip-path="url(#k${i})"><path d="${d}" fill="${sh}" mask="url(#q${i})"/></g>` : ''}
  <path d="${d}" fill="none" stroke="${P.line}" stroke-width="${w}" stroke-linejoin="round"/>`;
}
const L = (d, w = W * 0.7) => `<path d="${d}" fill="none" stroke="${P.line}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" fill="${P.bg}"/>
<g transform="${G.T}">
 <path d="M300 850 L900 850" stroke="${P.line}" stroke-width="${W}" stroke-linecap="round" opacity=".18"/>
 ${part(G.tail, P.el, null, [0,0], 11)}${part(G.tuft, P.line, null, [0,0], 4)}
 ${part(G.legHindFar, P.far)}${part(G.legFrontFar, P.far)}
 ${part(G.legHindNear, P.el, P.elSh, [16, 6])}${part(G.legFrontNear, P.el, P.elSh, [16, 6])}
 ${part(G.body, P.el, P.elSh, [22, 30])}
 ${part(G.trunk, P.el, P.elSh, [16, 14])}
 ${part(G.head, P.el, P.elSh, [22, 28])}
 <path d="${G.nailsFN}${G.nailsHN}" fill="${P.line}" transform="translate(0 -10)" opacity="0"/>
 ${L('M826 664 q22 7 40 0', 9)}${L('M824 692 q20 6 36 0', 9)}
 ${L('M690 812 l0 14 M712 812 l0 14 M334 812 l0 14 M356 812 l0 14', 8)}
 ${part(G.ear, P.el, P.elSh, [16, 18])}
 ${part(G.earInner, P.coral, P.coralD, [12, 14], 9)}
 <ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="16" ry="20" fill="${P.line}"/>
 <circle cx="${G.eye.cx - 4}" cy="${G.eye.cy - 7}" r="5.5" fill="#fff"/>
 ${L('M744 468 q22 -13 46 -3', 9)}
 <ellipse cx="800" cy="590" rx="20" ry="11" fill="${P.coral}" opacity=".65"/>
 ${L(G.mouth, 10)}
 <!-- gloss marks -->
 ${L('M664 412 q16 -10 34 -12', 0)}
 <path d="M660 418 q18 -14 40 -16" stroke="#fff" stroke-width="10" stroke-linecap="round" fill="none"/>
 <path d="M352 510 q22 -14 50 -18" stroke="#fff" stroke-width="10" stroke-linecap="round" fill="none"/>
 ${B.map(b => `<g transform="${b.tr}">
   ${part(b.side, P.kraftS)}${part(b.top, P.kraftT)}${part(b.front, P.kraft, P.kraftSh, [0, 16])}
   <path d="${b.tapeFront}" fill="${P.coral}"/><path d="${b.tapeTop}" fill="${P.coral}"/>
   ${L(b.seam, 7)}
   <path d="${b.handle}" fill="${P.line}"/>
 </g>`).join('')}
</g></svg>`;
fs.writeFileSync('c5.svg', svg);
