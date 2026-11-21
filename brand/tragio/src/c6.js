// C6 — półrealistyczny: malarskie światło, faktura skóry, koc tapicerski (derka), detale kartonu
const G = require('./geo'); const fs = require('fs');
const B = G.boxes2;
// quilted blanket
let bl = `M310 506 C356 468 470 458 602 468 C634 476 648 506 648 542 L650 600 `;
for (let i = 0; i < 6; i++) { const x0 = 650 - i * 57, x1 = x0 - 57; bl += `C${x0 - 18} ${606 + (i % 2) * 6} ${x1 + 18} ${612 - (i % 2) * 4} ${x1} 606 `; }
bl += `C302 570 300 532 310 506Z`;
const quilt = [];
for (let i = -6; i < 14; i++) { const x = 300 + i * 34; quilt.push(`M${x} 470 L${x + 150} 620`, `M${x + 150} 470 L${x} 620`); }
const skinStops = (a, b, c) => `<stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>`;
const wr = (x, y, w, c = .5) => `M${x} ${y} q${w / 2} ${w * 0.22 * c} ${w} 0`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>
<radialGradient id="bg" cx="38%" cy="30%" r="85%"><stop offset="0" stop-color="#5A4590"/><stop offset=".45" stop-color="#3B2C5E"/><stop offset="1" stop-color="#1B1330"/></radialGradient>
<radialGradient id="floor" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#0E0819" stop-opacity=".75"/><stop offset="1" stop-color="#0E0819" stop-opacity="0"/></radialGradient>
<linearGradient id="skin" x1=".1" y1="0" x2=".4" y2="1">${skinStops('#ABA1B8', '#857A96', '#54496C')}</linearGradient>
<linearGradient id="skinFar" x1="0" y1="0" x2="0" y2="1">${skinStops('#6F6388', '#5C5074', '#463B5E')}</linearGradient>
<radialGradient id="earIn" cx="45%" cy="40%" r="65%"><stop offset="0" stop-color="#E7A3A0"/><stop offset="1" stop-color="#B9757F"/></radialGradient>
<linearGradient id="blk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A68"/><stop offset="1" stop-color="#D9543A"/></linearGradient>
<linearGradient id="kF" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#EDBB7A"/><stop offset=".7" stop-color="#D99C58"/><stop offset="1" stop-color="#BF7F3E"/></linearGradient>
<linearGradient id="kT" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#F6D7A6"/><stop offset="1" stop-color="#E9BC7C"/></linearGradient>
<linearGradient id="kS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#B57536"/><stop offset="1" stop-color="#8C5523"/></linearGradient>
<linearGradient id="tape" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F2694A" stop-opacity=".92"/><stop offset=".35" stop-color="#FFA88E" stop-opacity=".95"/><stop offset=".5" stop-color="#FF8B6C" stop-opacity=".95"/><stop offset="1" stop-color="#E25B3D" stop-opacity=".92"/></linearGradient>
<filter id="vol" x="-10%" y="-10%" width="120%" height="120%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="11" result="b"/>
  <feOffset in="b" dx="-10" dy="-14" result="o1"/><feComposite in="SourceAlpha" in2="o1" operator="arithmetic" k2="1" k3="-1" result="sh"/>
  <feFlood flood-color="#2A1F45" flood-opacity=".65"/><feComposite in2="sh" operator="in" result="shadow"/>
  <feOffset in="b" dx="9" dy="12" result="o2"/><feComposite in="SourceAlpha" in2="o2" operator="arithmetic" k2="1" k3="-1" result="hl"/>
  <feFlood flood-color="#EDE6F5" flood-opacity=".45"/><feComposite in2="hl" operator="in" result="hilite"/>
  <feOffset in="b" dx="-6" dy="2" result="o3"/><feComposite in="SourceAlpha" in2="o3" operator="arithmetic" k2="1" k3="-1" result="rm"/>
  <feFlood flood-color="#FF9A7A" flood-opacity=".35"/><feComposite in2="rm" operator="in" result="rim"/>
  <feTurbulence type="fractalNoise" baseFrequency=".028 .055" numOctaves="4" seed="21" result="n"/>
  <feDiffuseLighting in="n" lighting-color="#fff" surfaceScale="2.4" result="bump"><feDistantLight azimuth="235" elevation="48"/></feDiffuseLighting>
  <feComposite in="bump" in2="SourceAlpha" operator="in" result="bumpC"/>
  <feMerge result="m"><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/><feMergeNode in="rim"/><feMergeNode in="hilite"/></feMerge>
  <feBlend in="m" in2="bumpC" mode="multiply" result="tex"/>
  <feComposite in="tex" in2="m" operator="arithmetic" k2=".42" k3=".58"/>
  <feComposite in2="SourceAlpha" operator="in"/>
</filter>
<filter id="volBox" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="3" seed="3" result="n"/>
  <feColorMatrix in="n" type="saturate" values="0"/><feComponentTransfer result="ng"><feFuncR type="linear" slope=".3" intercept=".35"/><feFuncG type="linear" slope=".3" intercept=".35"/><feFuncB type="linear" slope=".3" intercept=".35"/></feComponentTransfer>
  <feBlend in="SourceGraphic" in2="ng" mode="soft-light" result="t"/>
  <feComposite in="t" in2="SourceAlpha" operator="in"/>
</filter>
<filter id="ao" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="ao4"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="2" dy="8" stdDeviation="8" flood-color="#140B24" flood-opacity=".5"/></filter>
<clipPath id="blClip"><path d="${bl}"/></clipPath>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<g transform="${G.T}">
 <ellipse cx="600" cy="846" rx="380" ry="40" fill="url(#floor)"/>
 <g filter="url(#ao4)" fill="#0B0614" opacity=".7">
  <ellipse cx="333" cy="838" rx="48" ry="7"/><ellipse cx="460" cy="838" rx="42" ry="6"/><ellipse cx="592" cy="838" rx="42" ry="6"/><ellipse cx="704" cy="838" rx="50" ry="7"/><ellipse cx="880" cy="826" rx="50" ry="6"/>
 </g>
 <g filter="url(#vol)"><path d="${G.tail}" fill="url(#skin)"/><path d="${G.tuft}" fill="#3C3150"/></g>
 <g filter="url(#vol)"><path d="${G.legHindFar}" fill="url(#skinFar)"/><path d="${G.legFrontFar}" fill="url(#skinFar)"/></g>
 <g filter="url(#vol)"><path d="${G.legHindNear}" fill="url(#skin)"/><path d="${G.legFrontNear}" fill="url(#skin)"/><path d="${G.body}" fill="url(#skin)"/></g>
 <g filter="url(#vol)"><path d="${G.trunk}" fill="url(#skin)"/><path d="${G.head}" fill="url(#skin)"/></g>
 <!-- leg creases + nails -->
 <g stroke="#4B405E" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".55">
  <path d="${wr(612, 742, 40, -0.6)}"/><path d="${wr(620, 760, 44, -0.6)}"/><path d="${wr(340, 742, 40, -0.6)}"/><path d="${wr(330, 760, 44, -0.6)}"/>
 </g>
 <g fill="#E9E0D6" opacity=".95"><path d="${G.nailsFN}${G.nailsHN}" transform="translate(0 -5)"/></g>
 <g fill="#9F93AB" opacity=".9"><path d="${G.nailsFF}${G.nailsHF}" transform="translate(0 -5)"/></g>
 <!-- trunk wrinkles -->
 <g stroke="#4B405E" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".6">
  ${[620, 640, 658, 676, 694, 712, 730, 748].map((y, i) => `<path d="${wr(818 + i * 0.6, y, 50 - i * 1.5, 0.7)}"/>`).join('')}
 </g>
 <g stroke="#D6CCE0" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".35">
  ${[628, 648, 667, 685, 703, 721].map((y, i) => `<path d="${wr(822 + i * 0.6, y, 44 - i * 1.5, 0.7)}"/>`).join('')}
 </g>
 <!-- blanket -->
 <path d="${bl}" fill="#140B24" opacity=".45" filter="url(#ao)" transform="translate(4 10)"/>
 <g filter="url(#drop)"><path d="${bl}" fill="url(#blk)"/>
  <g clip-path="url(#blClip)"><path d="${quilt.join(' ')}" stroke="#B9452E" stroke-width="2.4" stroke-dasharray="7 6" opacity=".8"/>
   <path d="${quilt.join(' ')}" stroke="#FFB59E" stroke-width="1.4" stroke-dasharray="7 6" opacity=".45" transform="translate(1.4 -1.6)"/>
   <path d="M300 600 L660 600 L660 640 L300 640Z" fill="#B8432C"/>
   <path d="M300 592 C420 600 540 596 660 590" stroke="#FFC2AE" stroke-width="2" stroke-dasharray="6 5" opacity=".7" fill="none"/>
   <ellipse cx="420" cy="500" rx="140" ry="30" fill="#FFD3C4" opacity=".25" filter="url(#ao)"/></g>
 </g>
 <!-- ear -->
 <path d="${G.ear}" fill="#150C25" opacity=".5" filter="url(#ao)" transform="translate(6 12)"/>
 <g filter="url(#vol)"><path d="${G.ear}" fill="url(#skin)"/></g>
 <g filter="url(#vol)"><path d="${G.earInner}" fill="url(#earIn)"/></g>
 <g stroke="#8D5A6A" stroke-width="2" fill="none" opacity=".55" stroke-linecap="round">
  <path d="M640 486 C620 520 612 560 618 600"/><path d="M654 520 C640 548 636 584 640 618"/><path d="M618 500 C600 520 592 548 594 578"/>
 </g>
 <!-- face -->
 <ellipse cx="770" cy="574" rx="34" ry="18" fill="#C98A96" opacity=".35" filter="url(#ao4)"/>
 <path d="M744 476 q26 -16 54 -2" stroke="#5E5274" stroke-width="5" fill="none" stroke-linecap="round" opacity=".8"/>
 <ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="17" ry="20" fill="#2A1C16"/>
 <ellipse cx="${G.eye.cx + 1}" cy="${G.eye.cy + 1}" rx="12" ry="14" fill="#6B3F22"/>
 <ellipse cx="${G.eye.cx + 2}" cy="${G.eye.cy + 2}" rx="7" ry="9" fill="#120A08"/>
 <ellipse cx="${G.eye.cx - 4}" cy="${G.eye.cy - 7}" rx="5" ry="6" fill="#fff" opacity=".95"/>
 <path d="M748 492 Q770 474 792 490" stroke="#3A2F4C" stroke-width="5" fill="none" stroke-linecap="round"/>
 <g stroke="#2A2238" stroke-width="3" stroke-linecap="round" fill="none"><path d="M752 486 l-8 -9"/><path d="M761 481 l-5 -11"/><path d="M771 479 l-1 -11"/></g>
 <path d="${G.mouth}" stroke="#3A2F4C" stroke-width="5.5" fill="none" stroke-linecap="round"/>
 <!-- boxes -->
 ${B.map((b, i) => `<g transform="${b.tr}">
  <path d="${b.front}" fill="#120A1F" opacity=".5" filter="url(#ao)" transform="translate(6 12)"/>
  <g filter="url(#volBox)" stroke-linejoin="round">
   <path d="${b.side}" fill="url(#kS)" stroke="#9A6029" stroke-width="3"/>
   <path d="${b.top}" fill="url(#kT)" stroke="#D9A563" stroke-width="3"/>
   <path d="${b.front}" fill="url(#kF)" stroke="#C9894A" stroke-width="3"/>
  </g>
  <path d="M${b.x + 4} ${b.y + 4} Q${b.x + b.w / 2} ${b.y + 10} ${b.x + b.w - 4} ${b.y + 4}" stroke="#F8DDB0" stroke-width="3" fill="none" opacity=".8"/>
  <path d="${b.seam}" stroke="#B57A3C" stroke-width="2.5"/>
  <path d="${b.tapeTop}" fill="url(#tape)"/><path d="${b.tapeFront}" fill="url(#tape)"/>
  <path d="${b.tapeFront}" fill="none" stroke="#FFC9B8" stroke-width="1.5" opacity=".6"/>
  <path d="${b.handle}" fill="#3B220E"/>
  <path d="${b.handle}" fill="none" stroke="#F3CE97" stroke-width="2.5" transform="translate(0 2.5)" opacity=".6"/>
  ${i === 0 ? `<g fill="none" stroke="#7A4A1E" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".75">
     <path d="M${b.x + 30} ${b.y + 70} v-30 m-9 10 l9 -10 l9 10"/><path d="M${b.x + 52} ${b.y + 70} v-30 m-9 10 l9 -10 l9 10"/><path d="M${b.x + 20} ${b.y + 78} h44"/>
     <path d="M${b.x + b.w - 52} ${b.y + 36} h24 q0 22 -12 24 q-12 -2 -12 -24z M${b.x + b.w - 40} ${b.y + 60} v14 m-9 0 h18"/>
   </g>` : ''}
 </g>`).join('')}
</g>
<rect width="1024" height="1024" fill="url(#bg)" opacity="0"/>
</svg>`;
fs.writeFileSync('c6.svg', svg);
