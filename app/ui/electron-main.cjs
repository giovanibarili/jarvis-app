
const { app, BrowserWindow, screen } = require('electron');
const http = require('http');

let win;

// Grant microphone permission for Web Speech API
app.commandLine.appendSwitch('enable-speech-dispatcher');

app.whenReady().then(() => {
  // Set dock icon
  const path = require('path');
  const iconPath = path.join(process.cwd(), 'ui', 'public', 'jarvis-icon.png');
  if (require('fs').existsSync(iconPath) && app.dock) {
    const { nativeImage } = require('electron');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // Auto-grant media permissions (microphone)
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') {
      callback(true);
    } else {
      callback(true);
    }
  });
  // Select display: JARVIS_DISPLAY env (index) or first external, or primary
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const displayIndex = parseInt(process.env.JARVIS_DISPLAY ?? '', 10);
  const target = !isNaN(displayIndex) && displays[displayIndex]
    ? displays[displayIndex]
    : displays.find(d => d.id !== primary.id) ?? primary;

  win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    resizable: true,
    titleBarStyle: 'hidden',
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL('http://localhost:50052');

  // Size: 1920x1080 centered on target display
  const winWidth = Math.min(1920, target.bounds.width);
  const winHeight = Math.min(1080, target.bounds.height);
  const winX = target.bounds.x + Math.floor((target.bounds.width - winWidth) / 2);
  const winY = target.bounds.y + Math.floor((target.bounds.height - winHeight) / 2);
  win.setBounds({ x: winX, y: winY, width: winWidth, height: winHeight });
  // Temporary: capture ALL console messages for debugging
  win.webContents.on('console-message', (event, level, message) => {
    console.log('[E' + level + ']', message.slice(0, 300));
  });

  // Auto-reload when server comes back after restart
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => win.loadURL('http://localhost:50052'), 2000);
  });

  // Screenshot + info server on port 50053
  http.createServer(async (req, res) => {
    if (req.url === '/info' && win) {
      const bounds = win.getBounds();
      const size = win.getContentSize();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bounds, contentSize: size }));
      return;
    }
    if (req.url === '/screenshot' && win) {
      try {
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    } else if (req.url === '/reload' && win) {
      win.webContents.reload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(50053);
});

app.on('window-all-closed', () => app.quit());
