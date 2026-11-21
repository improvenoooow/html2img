// C3 — linoryt / szyld retro: 3 farby (śliwka, koral, kraft) na kremowym papierze
const G = require('./geo'); const { tube } = require('./lib'); const fs = require('fs');
const B = G.boxes2;
const P = { paper: '#F4EADB', ink: '#33254F', coral: '#FF7A59', kraft: '#E3AC68' };
// gouge: tapered carved line along a cubic poly-curve
const gouge = (pts, w = 9) => tube(pts, t => Math.max(0.6, w * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6)), { n: 24, step: 2 });
const arc = (x1, y1, x2, y2, bend) => { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2; return [[x1, y1], [x1 + (mx - x1) * 0.6, y1 + bend], [x2 - (x2 - mx) * 0.6, y2 + bend], [x2, y2]]; };
const cuts = [];
// back/body: cuts following the back contour, light side = upper-left
[[330, 520, 560, 500, -18, 10], [318, 552, 540, 534, -16, 9], [312, 586, 500, 572, -12, 8], [312, 620, 450, 612, -8, 7], [318, 652, 400, 650, -4, 5.5]]
  .forEach(([a, b, c, d, e, w]) => cuts.push(gouge(arc(a, b, c, d, e), w)));
// rump curves
cuts.push(gouge([[300, 560], [296, 610], [306, 660], [330, 700]], 7));
// belly hatch (short, dense = shadow side kept dark)
// head: arcs following the crown
[[640, 430, 790, 410, -26, 10], [628, 462, 800, 444, -24, 8.5], [626, 496, 720, 478, -14, 6.5]]
  .forEach(([a, b, c, d, e, w]) => cuts.push(gouge(arc(a, b, c, d, e), w)));
// trunk rings
[[826, 640, 866, 640], [824, 670, 868, 672], [822, 700, 866, 704], [822, 730, 862, 736]].forEach(([a, b, c, d], i) => cuts.push(gouge(arc(a, b, c, d, 7), 6 - i * 0.6)));
// legs: one carved edge each (near legs)
cuts.push(gouge([[612, 668], [618, 720], [630, 770], [646, 808]], 7));
cuts.push(gouge([[352, 668], [344, 720], [330, 770], [318, 806]], 7));
// ear: inner contour cut
const earCut = gouge([[676, 452], [628, 428], [566, 462], [560, 528]], 9);
const earCut2 = gouge([[560, 540], [552, 600], [580, 660], [624, 682]], 9);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>
<filter id="rough" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="3" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="7" xChannelSelector="R" yChannelSelector="G"/></filter>
<filter id="ink" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="3" result="t"/>
  <feDisplacementMap in="SourceGraphic" in2="t" scale="6" xChannelSelector="R" yChannelSelector="G" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency=".45" numOctaves="3" seed="11" result="n"/>
  <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -18 12.6" result="speck"/>
  <feComposite in="d" in2="speck" operator="in"/>
</filter>
<filter id="paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".6" numOctaves="3" seed="5"/><feDiffuseLighting lighting-color="#fff" surfaceScale="1.6"><feDistantLight azimuth="225" elevation="55"/></feDiffuseLighting><feComposite in2="SourceGraphic" operator="in"/></filter>
<mask id="carve" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/><path d="${cuts.join(' ')}" fill="#000"/><path d="${earCut} ${earCut2}" fill="#000"/></mask>
</defs>
<rect width="1024" height="1024" fill="${P.paper}"/>
<rect width="1024" height="1024" filter="url(#paper)" opacity=".5" style="mix-blend-mode:soft-light"/>
<g filter="url(#ink)">
 <circle cx="512" cy="500" r="356" fill="${P.coral}" transform="translate(3 -2)"/>
</g>
<g transform="${G.T}">
 <!-- ground strokes -->
 <g filter="url(#ink)" fill="${P.ink}"><path d="${gouge([[300, 846], [450, 840], [650, 842], [900, 846]], 10)}"/><path d="${gouge([[380, 868], [500, 864], [640, 866], [760, 868]], 6)}"/></g>
 <!-- key block (plum) with carved lines -->
 <g filter="url(#ink)"><g mask="url(#carve)" fill="${P.ink}">
  <path d="${G.tail}"/><path d="${G.tuft}"/>
  <path d="${G.legHindFar}"/><path d="${G.legFrontFar}"/>
  <path d="${G.legHindNear}" stroke="${P.paper}" stroke-width="11"/><path d="${G.legFrontNear}" stroke="${P.paper}" stroke-width="11"/>
  <path d="${G.body}"/><path d="${G.trunk}"/><path d="${G.head}"/><path d="${G.ear}"/>
 </g>
 <!-- separations carved between legs/body -->
 <g fill="${P.paper}">
  <path d="${G.nailsFN}${G.nailsHN}" transform="translate(0 -8)"/>
  <ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="19" ry="22"/>
  <path d="${gouge(arc(744, 646, 800, 646, 12), 8)}"/>
 </g>
 <ellipse cx="${G.eye.cx + 4}" cy="${G.eye.cy + 3}" rx="10" ry="13" fill="${P.ink}"/>
 </g>
 <!-- coral inner ear (2nd colour, slight misregister) -->
 <g filter="url(#ink)" transform="translate(-3 2)"><path d="${G.earInner}" fill="${P.coral}"/></g>
 <!-- boxes: kraft colour + plum key lines -->
 ${B.map(b => `<g transform="${b.tr}">
   <g filter="url(#ink)" transform="translate(2 -2)"><path d="${b.front}" fill="${P.kraft}"/><path d="${b.top}" fill="${P.kraft}"/></g>
   <g filter="url(#ink)" fill="none" stroke="${P.ink}" stroke-linejoin="round" stroke-linecap="round">
    <path d="${b.front}" stroke-width="9"/><path d="${b.top}" stroke-width="9"/>
    <path d="${b.side}" fill="${P.ink}" stroke-width="9"/>
    <path d="${b.seam}" stroke-width="5"/>
   </g>
   <g filter="url(#ink)"><path d="${b.tapeFront}" fill="${P.coral}"/><path d="${b.tapeTop}" fill="${P.coral}"/>
   <path d="${b.handle}" fill="${P.ink}"/></g>
 </g>`).join('')}
</g>
</svg>`;
fs.writeFileSync('c3.svg', svg);
