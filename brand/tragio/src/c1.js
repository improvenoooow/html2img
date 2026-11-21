// C1 — miękkie 3D clay
const G = require('./geo'); const fs = require('fs');
const B = G.boxes2;
const defs = `
<radialGradient id="bg" cx="42%" cy="34%" r="80%"><stop offset="0" stop-color="#55418A"/><stop offset=".55" stop-color="#3B2C5E"/><stop offset="1" stop-color="#271C42"/></radialGradient>
<linearGradient id="skin" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="#C9BEEA"/><stop offset=".6" stop-color="#AA9CD6"/><stop offset="1" stop-color="#8E7FC0"/></linearGradient>
<linearGradient id="skinFar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7464A6"/><stop offset="1" stop-color="#5A4C8C"/></linearGradient>
<linearGradient id="earG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B9ACE0"/><stop offset="1" stop-color="#9081C2"/></linearGradient>
<radialGradient id="earIn" cx="55%" cy="40%" r="70%"><stop offset="0" stop-color="#FFB3A0"/><stop offset="1" stop-color="#E98A86"/></radialGradient>
<linearGradient id="kF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EDB977"/><stop offset="1" stop-color="#D69652"/></linearGradient>
<linearGradient id="kT" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#F7D29C"/><stop offset="1" stop-color="#F0C384"/></linearGradient>
<linearGradient id="kS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C98A47"/><stop offset="1" stop-color="#A86D31"/></linearGradient>
<linearGradient id="tape" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FF8C6E"/><stop offset=".45" stop-color="#FFA58C"/><stop offset="1" stop-color="#F26A4A"/></linearGradient>
<filter id="clay" x="-10%" y="-10%" width="120%" height="120%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="16" result="b"/>
  <feOffset in="b" dx="-14" dy="-18" result="o1"/>
  <feComposite in="SourceAlpha" in2="o1" operator="arithmetic" k2="1" k3="-1" result="sh"/>
  <feFlood flood-color="#3E2F73" flood-opacity=".55"/><feComposite in2="sh" operator="in" result="shadow"/>
  <feOffset in="b" dx="12" dy="16" result="o2"/>
  <feComposite in="SourceAlpha" in2="o2" operator="arithmetic" k2="1" k3="-1" result="hl"/>
  <feFlood flood-color="#FFFFFF" flood-opacity=".42"/><feComposite in2="hl" operator="in" result="hilite"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/><feMergeNode in="hilite"/></feMerge>
  <feComposite in2="SourceAlpha" operator="in"/>
</filter>
<filter id="clayBox" x="-10%" y="-10%" width="120%" height="120%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b"/>
  <feOffset in="b" dx="-6" dy="-8" result="o1"/>
  <feComposite in="SourceAlpha" in2="o1" operator="arithmetic" k2="1" k3="-1" result="sh"/>
  <feFlood flood-color="#7A4A1C" flood-opacity=".45"/><feComposite in2="sh" operator="in" result="shadow"/>
  <feOffset in="b" dx="5" dy="7" result="o2"/>
  <feComposite in="SourceAlpha" in2="o2" operator="arithmetic" k2="1" k3="-1" result="hl"/>
  <feFlood flood-color="#FFF6E6" flood-opacity=".55"/><feComposite in2="hl" operator="in" result="hilite"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/><feMergeNode in="hilite"/></feMerge>
  <feComposite in2="SourceAlpha" operator="in"/>
</filter>
<filter id="clayS" x="-10%" y="-10%" width="120%" height="120%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b"/>
  <feOffset in="b" dx="-6" dy="-8" result="o1"/><feComposite in="SourceAlpha" in2="o1" operator="arithmetic" k2="1" k3="-1" result="sh"/>
  <feFlood flood-color="#B4545A" flood-opacity=".5"/><feComposite in2="sh" operator="in" result="shadow"/>
  <feOffset in="b" dx="5" dy="7" result="o2"/><feComposite in="SourceAlpha" in2="o2" operator="arithmetic" k2="1" k3="-1" result="hl"/>
  <feFlood flood-color="#FFF" flood-opacity=".35"/><feComposite in2="hl" operator="in" result="hilite"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/><feMergeNode in="hilite"/></feMerge><feComposite in2="SourceAlpha" operator="in"/>
</filter>
<filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="4" dy="10" stdDeviation="10" flood-color="#21173D" flood-opacity=".38"/></filter>
<filter id="dropS" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="2" dy="6" stdDeviation="6" flood-color="#2A1C4A" flood-opacity=".35"/></filter>
<filter id="soft"><feGaussianBlur stdDeviation="12"/></filter>
<filter id="soft4"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .5"/></feComponentTransfer><feComposite in2="SourceGraphic" operator="in"/></filter>
<clipPath id="headClip"><path d="${G.head}"/></clipPath>
<clipPath id="bodyClip"><path d="${G.body}"/></clipPath>`;
const boxSvg = (b, i) => `<g transform="${b.tr}" filter="url(#dropS)"><g filter="url(#clayBox)" stroke-linejoin="round">
  <path d="${b.side}" fill="url(#kS)" stroke="#B57A3C" stroke-width="6"/>
  <path d="${b.top}" fill="url(#kT)" stroke="#F2C88C" stroke-width="6"/>
  <path d="${b.front}" fill="url(#kF)" stroke="#E2A764" stroke-width="6"/>
  <path d="${b.seam}" stroke="#C98C4B" stroke-width="3" stroke-linecap="round" opacity=".7"/>
  <path d="${b.tapeTop}" fill="#FF8D70"/><path d="${b.tapeFront}" fill="url(#tape)"/>
  <path d="${b.handle}" fill="#5E3A17"/>
 </g>
 <path d="${b.handle}" fill="none" stroke="#F6D2A0" stroke-width="2.5" opacity=".7" transform="translate(1.5 2.5)"/>
</g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${defs}</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<g transform="${G.T}">
 <ellipse cx="610" cy="842" rx="330" ry="20" fill="#160E2B" opacity=".55" filter="url(#soft)"/>
 <g filter="url(#drop)">
  <g filter="url(#clay)"><path d="${G.tail}" fill="url(#skin)"/></g>
  <path d="${G.tuft}" fill="#7A6BAA"/>
  <g filter="url(#clay)"><path d="${G.legHindFar}" fill="url(#skinFar)"/></g>
  <g filter="url(#clay)"><path d="${G.legFrontFar}" fill="url(#skinFar)"/></g>
  <g filter="url(#clay)"><path d="${G.legHindNear}" fill="url(#skin)"/><path d="${G.legFrontNear}" fill="url(#skin)"/><path d="${G.body}" fill="url(#skin)"/></g>
  <g filter="url(#clay)"><path d="${G.trunk}" fill="url(#skin)"/><path d="${G.head}" fill="url(#skin)"/></g>
 </g>
 <path d="${G.nailsFN}${G.nailsHN}" fill="#EFE6F7" opacity=".9" transform="translate(0 -6)"/>
 <path d="${G.nailsFF}${G.nailsHF}" fill="#B3A6D6" opacity=".9" transform="translate(0 -6)"/>
 <!-- trunk rings -->
 <g stroke="#8676B9" stroke-width="3.5" stroke-linecap="round" fill="none" opacity=".55">
  <path d="M832 664 q22 6 38 0"/><path d="M830 690 q20 6 36 0"/><path d="M826 716 q20 5 34 -1"/>
 </g>
 <!-- ear -->
 <g filter="url(#drop)"><g filter="url(#clay)"><path d="${G.ear}" fill="url(#earG)"/></g></g>
 <path d="${G.earInner}" fill="#6F5FA6" opacity=".5" transform="translate(3 5)" filter="url(#soft4)"/><g filter="url(#clayS)"><path d="${G.earInner}" fill="url(#earIn)"/></g>
 <!-- face -->
 <ellipse cx="796" cy="586" rx="26" ry="16" fill="#FF8B78" opacity=".45" filter="url(#soft4)"/>
 <ellipse cx="${G.eye.cx}" cy="${G.eye.cy}" rx="${G.eye.rx}" ry="${G.eye.ry}" fill="#1E1438"/>
 <ellipse cx="${G.eye.cx - 5}" cy="${G.eye.cy - 8}" rx="6" ry="7" fill="#fff"/>
 <circle cx="${G.eye.cx + 6}" cy="${G.eye.cy + 8}" r="2.6" fill="#fff" opacity=".8"/>
 <path d="M748 468 q20 -12 42 -2" stroke="#7F70B4" stroke-width="5" fill="none" stroke-linecap="round" opacity=".8"/>
 <path d="${G.mouth}" stroke="#3A2A66" stroke-width="6" fill="none" stroke-linecap="round"/>
 <!-- crown highlight -->
 <ellipse cx="700" cy="408" rx="54" ry="20" fill="#fff" opacity=".28" filter="url(#soft4)" transform="rotate(-12 700 408)"/>
 <!-- contact shadow under boxes -->
 <path d="M340 482 Q470 466 600 478 L600 506 Q470 492 340 508Z" fill="#3E2F73" opacity=".45" filter="url(#soft4)"/>
 ${B.map(boxSvg).join('')}
</g>
<rect width="1024" height="1024" filter="url(#grain)" opacity=".10" style="mix-blend-mode:overlay"/>
</svg>`;
fs.writeFileSync('c1.svg', svg);
