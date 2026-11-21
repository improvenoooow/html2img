const { tube, smooth } = require('./lib');
// Elephant facing right, ground y=834. All in 1024 space (before fit transform).
const G = {};
G.body = `M322 494 C368 462 490 454 588 466 C634 478 658 520 666 572 C674 630 666 692 636 724 C594 756 492 762 412 754 C346 746 300 714 290 652 C283 594 292 526 322 494Z`;
G.head = `M594 476 C604 406 662 368 728 370 C804 374 856 430 860 504 C862 542 856 568 846 588 C826 640 784 672 738 678 C688 686 634 668 604 634 C576 598 578 522 594 476Z`;
G.trunk = `M842 500 C864 572 876 646 868 708 C864 734 864 752 880 756 C896 758 908 750 918 740 C932 728 952 736 952 758 C952 792 924 820 884 821 C836 822 808 792 806 748 C804 704 798 662 780 626 L780 520Z`;
G.ear = `M690 434 C632 404 560 440 548 512 C536 586 560 660 616 690 C640 702 662 696 672 680 C680 668 682 656 690 648 C706 620 716 512 690 434Z`;
G.earInner = `M676 462 C634 442 584 474 576 530 C568 590 590 646 628 664 C648 672 662 662 668 648 C680 620 692 520 676 462Z`;
// legs
G.legFrontNear = `M604 648 C610 720 630 788 646 820 Q652 836 670 836 L742 836 Q760 836 756 816 C748 766 722 700 704 640Z`;
G.legFrontFar  = `M566 654 C562 720 552 790 547 820 Q544 836 560 836 L626 836 Q642 836 640 820 C638 760 646 702 648 654Z`;
G.legHindNear  = `M340 642 C328 716 306 788 292 820 Q286 836 304 836 L370 836 Q386 836 386 820 C392 762 426 702 444 652Z`;
G.legHindFar   = `M394 664 C404 730 414 790 420 820 Q422 836 438 836 L498 836 Q514 836 512 820 C506 770 502 712 494 664Z`;
G.tail = tube([[298,566],[278,592],[266,630],[270,668]], t => 13 - 5 * t, { n: 30, step: 3 });
G.tuft = `M260 660 C252 680 260 702 274 704 C288 702 290 684 282 664Z`;
G.eye = { cx: 770, cy: 504, rx: 18, ry: 22 };
G.mouth = `M748 640 C760 654 780 656 794 644`;
// boxes: front face + top + side (oblique). returns parts
function box({ x, y, w, h, d = [28, -20], sag = 6, bulge = 4, archBottom = 0, rot = 0 }) {
  const x2 = x + w, yb = y + h;
  const front = `M${x} ${y} Q${x + w/2} ${y + sag} ${x2} ${y} Q${x2 + bulge} ${y + h/2} ${x2} ${yb} Q${x + w/2} ${yb - archBottom} ${x} ${yb} Q${x - bulge} ${y + h/2} ${x} ${y}Z`;
  const top = `M${x} ${y} Q${x + w/2} ${y + sag} ${x2} ${y} L${x2 + d[0]} ${y + d[1]} Q${x + w/2 + d[0]} ${y + d[1] + sag*0.6} ${x + d[0]} ${y + d[1]}Z`;
  const side = `M${x2} ${y} L${x2 + d[0]} ${y + d[1]} Q${x2 + d[0] + bulge*0.7} ${y + d[1] + h/2} ${x2 + d[0]} ${yb + d[1]} Q${x2 + d[0]/2 + bulge} ${yb + d[1]/2 - archBottom*0.3} ${x2} ${yb} Q${x2 + bulge} ${y + h/2} ${x2} ${y}Z`;
  const tw = Math.max(18, w * 0.15), tx = x + w/2 - tw/2;
  const tapeFront = `M${tx} ${y + sag*0.95} L${tx + tw} ${y + sag*0.95} L${tx + tw} ${y + h*0.36} L${tx} ${y + h*0.36}Z`;
  const tapeTop = `M${tx} ${y + sag*0.95} L${tx + tw} ${y + sag*0.95} L${tx + tw + d[0]} ${y + d[1] + sag*0.6} L${tx + d[0]} ${y + d[1] + sag*0.6}Z`;
  const seam = `M${x + w/2 + d[0]*0.08} ${y + sag*0.9 + d[1]*0.08} L${x + w/2 + d[0]*0.92} ${y + d[1]*0.92 + sag*0.6}`;
  const hx = x + w * 0.5, hy = y + h * 0.62;
  const handle = `M${hx - w*0.13} ${hy} a${h*0.07} ${h*0.07} 0 0 1 ${h*0.07} -${h*0.07} h${w*0.26 - h*0.14} a${h*0.07} ${h*0.07} 0 0 1 0 ${h*0.14} h-${w*0.26 - h*0.14} a${h*0.07} ${h*0.07} 0 0 1 -${h*0.07} -${h*0.07}Z`;
  const cx = x + w/2 + d[0]/2, cy = yb;
  const tr = rot ? `rotate(${rot} ${cx} ${cy})` : '';
  return { front, top, side, tapeFront, tapeTop, seam, handle, tr, x, y, w, h, d };
}
G.box = box;
G.boxes3 = [
  box({ x: 330, y: 340, w: 252, h: 132, archBottom: 12, sag: 7, bulge: 6 }),
  box({ x: 352, y: 244, w: 200, h: 98, d: [24, -17], sag: 5, bulge: 4, rot: -2.5 }),
  box({ x: 386, y: 170, w: 132, h: 76, d: [20, -14], sag: 3, bulge: 3, rot: 3 }),
];
G.boxes2 = [
  box({ x: 338, y: 326, w: 256, h: 152, d: [30, -22], archBottom: 14, sag: 8, bulge: 6 }),
  box({ x: 366, y: 206, w: 204, h: 120, d: [28, -20], sag: 5, bulge: 4, rot: -2 }),
];
module.exports = G;

G.nails = (x, y, n = 3, sp = 19, r = 8) => Array.from({ length: n }, (_, i) => `M${x + i*sp - r} ${y} a${r} ${r*0.9} 0 0 1 ${2*r} 0Z`).join('');
G.nailsFN = G.nails(690, 836); G.nailsHN = G.nails(332, 836);
G.nailsFF = G.nails(584, 836, 3, 17, 7); G.nailsHF = G.nails(458, 836, 3, 17, 7);
// moving blanket (derka) draped over the back, under the boxes
G.blanket = `M318 500 C360 470 470 462 600 470 C626 476 640 500 646 530 C650 556 648 578 642 596 C600 606 560 596 520 604 C480 612 440 600 400 608 C362 614 330 602 306 592 C298 560 302 522 318 500Z`;
G.blanketHem = `M306 592 C330 602 362 614 400 608 C440 600 480 612 520 604 C560 596 600 606 642 596 L644 578 C602 588 560 578 520 586 C480 594 440 582 400 590 C362 596 330 586 303 574Z`;
G.T = 'translate(512 520) scale(1.04) translate(-600 -508)';
