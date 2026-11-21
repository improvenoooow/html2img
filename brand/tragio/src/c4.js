// C4 — papierowa wycinanka: warstwy papieru, cienie między warstwami, faktura włókien; derka (koc do przeprowadzek) z ząbkiem
const G = require('./geo'); const fs = require('fs');
const B = G.boxes2;
const P = { bg: '#2F2350', bg2: '#3B2C5E', el: '#CFC3EA', elFar: '#A495CF', coral: '#FF7A59', cream: '#F6F1EC', kraft: '#E3AC68', ink: '#2A1F45' };
// scalloped hem for the blanket (wycinanka edge)
let hem = 'M306 590 '; for (let i = 0; i < 12; i++) { const x = 306 + i * 28.5; hem += `Q${x + 14.25} ${612 + (i % 2 ? 4 : 0)} ${x + 28.5} 592 `; }
const blanket = `M318 498 C360 468 470 460 604 470 C632 478 646 504 648 540 L648 592 ${hem.replace('M306 590 ', '').split(' ').length ? '' : ''}`;
// build blanket path: top along back, down right side, scalloped bottom right->left, up left side
let bl = `M312 504 C356 470 470 460 602 470 C632 478 646 506 646 540 L646 588 `;
for (let i = 0; i < 12; i++) { const x0 = 646 - i * 28.3, x1 = x0 - 28.3; bl += `Q${x0 - 14.15} ${618} ${x1} 588 `; }
bl += `C304 560 302 528 312 504Z`;
const stitch = `M318 560 C420 548 540 550 640 560`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>
<filter id="fiber" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".022 .9" numOctaves="2" seed="4" result="f"/><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="9" result="g"/><feBlend in="f" in2="g" mode="multiply" result="n"/><feDiffuseLighting in="n" lighting-color="#fff" surfaceScale="2.2"><feDistantLight azimuth="235" elevation="50"/></feDiffuseLighting><feComposite in2="SourceGraphic" operator="in"/></filter>
<filter id="cut" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="2" seed="2" result="t"/>
  <feDisplacementMap in="SourceGraphic" in2="t" scale="3.5" xChannelSelector="R" yChannelSelector="G" result="d"/>
  <feDropShadow in="d" dx="3" dy="7" stdDeviation="5" flood-color="#140C26" flood-opacity=".42"/>
</filter>
<filter id="cutS" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="2" seed="6" result="t"/>
  <feDisplacementMap in="SourceGraphic" in2="t" scale="3" xChannelSelector="R" yChannelSelector="G" result="d"/>
  <feDropShadow in="d" dx="1.5" dy="3.5" stdDeviation="2.5" flood-color="#140C26" flood-opacity=".38"/>
</filter>
<pattern id="tex" width="1024" height="1024" patternUnits="userSpaceOnUse"><rect width="1024" height="1024" fill="#808080"/><rect width="1024" height="1024" fill="#fff" filter="url(#fiber)"/></pattern>
<radialGradient id="vig" cx="50%" cy="45%" r="70%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient>
</defs>
<rect width="1024" height="1024" fill="${P.bg}"/>
<!-- back paper layer: big soft disc -->
<g filter="url(#cut)"><circle cx="512" cy="512" r="376" fill="${P.bg2}"/></g>
<g transform="${G.T}">
 <g filter="url(#cut)"><path d="${G.tail}" fill="${P.el}"/><path d="${G.tuft}" fill="${P.coral}"/></g>
 <g filter="url(#cut)"><path d="${G.legHindFar}" fill="${P.elFar}"/><path d="${G.legFrontFar}" fill="${P.elFar}"/></g>
 <g filter="url(#cut)"><path d="${G.legHindNear}" fill="${P.el}"/><path d="${G.legFrontNear}" fill="${P.el}"/><path d="${G.body}" fill="${P.el}"/></g>
 <g filter="url(#cut)"><path d="${G.trunk}" fill="${P.el}"/><path d="${G.head}" fill="${P.el}"/></g>
 <g filter="url(#cutS)" fill="${P.cream}"><path d="${G.nailsFN}${G.nailsHN}" transform="translate(0 -7)"/></g>
 <!-- trunk folds: paper strips -->
 <g filter="url(#cutS)" fill="none" stroke="${P.elFar}" stroke-width="7" stroke-linecap="round"><path d="M826 664 q22 8 42 0"/><path d="M824 694 q20 7 38 0"/></g>
 <!-- blanket (derka) -->
 <g filter="url(#cut)"><path d="${bl}" fill="${P.coral}"/></g>
 <g filter="url(#cutS)"><path d="${stitch}" stroke="${P.cream}" stroke-width="5" stroke-dasharray="14 12" stroke-linecap="round" fill="none"/>
  ${Array.from({ length: 8 }, (_, i) => { const x = 346 + i * 37; return `<circle cx="${x}" cy="${582}" r="5.5" fill="${P.cream}"/>`; }).join('')}
 </g>
 <!-- ear: separate pieces -->
 <g filter="url(#cut)"><path d="${G.ear}" fill="#BBAEE0"/></g>
 <g filter="url(#cutS)"><path d="${G.earInner}" fill="${P.coral}"/></g>
 <!-- face -->
 <g filter="url(#cutS)"><ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="17" ry="21" fill="${P.ink}"/></g>
 <circle cx="${G.eye.cx - 5}" cy="${G.eye.cy - 7}" r="5.5" fill="#fff"/>
 <g filter="url(#cutS)"><ellipse cx="800" cy="590" rx="20" ry="12" fill="#FF9C80"/></g>
 <g filter="url(#cutS)"><path d="${G.mouth}" stroke="${P.ink}" stroke-width="7" fill="none" stroke-linecap="round"/></g>
 <!-- boxes: each face is its own paper piece -->
 ${B.map(b => `<g transform="${b.tr}">
   <g filter="url(#cut)"><path d="${b.side}" fill="#BC7F3E"/><path d="${b.top}" fill="#F2C88A"/><path d="${b.front}" fill="${P.kraft}"/></g>
   <g filter="url(#cutS)"><path d="${b.tapeTop}" fill="#FF9475"/><path d="${b.tapeFront}" fill="${P.coral}"/></g>
   <path d="${b.handle}" fill="#4A2E14"/>
 </g>`).join('')}
</g>
<rect width="1024" height="1024" fill="url(#tex)" opacity=".22" style="mix-blend-mode:overlay"/>
<rect width="1024" height="1024" fill="url(#vig)"/>
</svg>`;
fs.writeFileSync('c4.svg', svg);
