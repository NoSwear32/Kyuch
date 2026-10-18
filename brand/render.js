// Rasterizes SVGs to PNG with Electron's Chromium (no extra tools needed).
// usage: electron brand/render.js <in.svg> <out.png> <width> [height]   (height defaults to the SVG's aspect ratio)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const [src, dst, w, h] = process.argv.slice(2);
  const svg = fs.readFileSync(src, 'utf8');
  const [, vw, vh] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const W = +w, H = h ? +h : Math.round((W * vh) / vw);
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:${W}px;height:${H}px;display:block">`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
  fs.writeFileSync(dst, img.toPNG());
  app.quit();
});
