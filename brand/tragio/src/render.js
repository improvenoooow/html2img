// usage: node render.js file.svg [file2.svg ...]  -> out/<name>.png (1024) + out/<name>_sm.png (preview strip)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  for (const f of process.argv.slice(2)) {
    const svg = fs.readFileSync(f, 'utf8');
    const name = path.basename(f, '.svg');
    await p.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await p.waitForTimeout(150);
    const png = await p.screenshot({ clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    fs.writeFileSync(`out/${name}.png`, png);
  }
  await b.close();
})();
