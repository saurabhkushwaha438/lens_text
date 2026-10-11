const {
  app, BrowserWindow, desktopCapturer, globalShortcut, screen, clipboard,
  ipcMain, Tray, Menu, nativeImage, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const Tesseract = require('tesseract.js');

let tesseractWorker = null;
let overlay = null;
let busy = false;
let tray = null;

// Windows toast notifications are attributed via the AppUserModelID; without
// it the packaged app's startup notification silently never appears.
app.setAppUserModelId('com.lenstext.app');

// When packaged, this file lives inside app.asar, but ocr.ps1/ocr.py are
// executed by EXTERNAL processes (PowerShell, Python) that cannot read inside
// an asar archive. electron-builder unpacks them (see asarUnpack in
// package.json), so translate app.asar -> app.asar.unpacked for those paths.
function resourcePath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', name)
    : path.join(__dirname, name);
}
// Monotonic capture id: only the LATEST capture/refresh may send 'boxes', so
// OCR still in flight from a superseded capture (user scrolled + recaptured)
// can't overwrite fresh boxes with coordinates from the old screenshot.
let captureSeq = 0;

// Multi-select: the mode the user last chose, re-sent to each new overlay so
// captures keep opening in Single or Multi. Chip contents themselves live in
// the renderer; main only receives the final joined text on 'copyAll'.
// Default Multi: collecting text from several places is the point of the app;
// Single (drag -> copy -> close) stays one toggle away.
let chipMode = true;

// Prevent the classic trap: a second `npm start` while an old instance is
// still alive. The OLD process keeps the global shortcut, so hotkey presses
// silently run stale code. Second instances just focus/notify and exit.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.warn('lens-text is already running - use that instance (it owns the hotkey).');
  app.quit();
}
app.on('second-instance', () => {
  console.log('Another launch attempt was ignored; this instance keeps the hotkey.');
});

app.whenReady().then(() => {
  const ok = globalShortcut.register('CommandOrControl+Shift+X', startCapture);
  console.log(ok
    ? 'Press Ctrl+Shift+X to select text. Esc to cancel.'
    : 'WARNING: Ctrl+Shift+X is registered by another app - hotkey will not work!');

  // Installed app has no terminal and (usually) no window: give it a tray
  // menu with Quit, a startup toast so the user knows it is running, and
  // auto-launch with Windows so the hotkey is always available.
  setupTray();
  maybeAutoLaunch();
  if (Notification.isSupported()) {
    setTimeout(() => {
      new Notification({
        title: 'Lens Text is running',
        body: 'Press Ctrl+Shift+X to select text from anywhere.',
      }).show();
    }, 1200);
  }

  // Pre-warm the PaddleOCR worker in the background so the ~6s model load
  // happens at startup instead of on the user's first hotkey press.
  ensureOcrProc();
  console.log('PaddleOCR worker warming up in the background...');
});

function setupTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png')
    : path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);
  // Windows scales tray icons best from a small bitmap.
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Lens Text - Ctrl+Shift+X to select text');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Select text\tCtrl+Shift+X', click: () => startCapture() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// Start with Windows by default (installed-app expectation: the hotkey must
// just be there). No-op in dev; failure is logged, never fatal.
function maybeAutoLaunch() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
  } catch (err) {
    console.warn('Auto-launch setup failed:', err.message);
  }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});

// Without this, closing the overlay (the only window) triggers Electron's default
// window-all-closed behaviour and quits the app, killing the global shortcut after
// the very first selection. Registering the listener keeps the app alive.
app.on('window-all-closed', () => {});

// ---------------------------------------------------------------------------
// OCR engines. Both return a flat word list in captured-image pixels:
// [{ text, x0, y0, x1, y1 }, ...]
// ---------------------------------------------------------------------------

// Windows 10/11 built-in WinRT OCR, driven through PowerShell (ocr.ps1).
// No model downloads, fast, and noticeably better than Tesseract on UI text.
function windowsOcr(pngBuf) {
  const tmp = path.join(os.tmpdir(), `lens-text-${Date.now()}.png`);
  fs.writeFileSync(tmp, pngBuf);

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resourcePath('ocr.ps1'), '-ImagePath', tmp],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) return reject(new Error(stderr.trim() || err.message));
        try {
          // PowerShell 5.1's ConvertTo-Json can emit control characters raw
          // (e.g. a misread glyph becomes U+0007), which breaks JSON.parse.
          const clean = stdout.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
          const parsed = JSON.parse(clean);
          const words = [];
          for (const line of parsed.lines || []) {
            for (const w of line.words || []) words.push(w);
          }
          resolve(words);
        } catch (e) {
          reject(new Error('Bad OCR output: ' + e.message));
        }
      }
    );
  });
}

// PaddleOCR (PP-OCRv4 models via RapidOCR/ONNX) served by a persistent Python
// worker so the ~5s model load happens once, not per capture.
let ocrProc = null;
let ocrQueue = [];
let ocrJob = null; // job currently in flight (with resolve/reject wrappers)

function paddleOcr(pngBuf) {
  const tmp = path.join(os.tmpdir(), `lens-text-${Date.now()}.png`);
  fs.writeFileSync(tmp, pngBuf);

  return new Promise((resolve, reject) => {
    ocrQueue.push({ tmp, resolve, reject });
    pumpOcrQueue();
  });
}

function ensureOcrProc() {
  if (ocrProc) return ocrProc;
  ocrProc = spawn('python', [resourcePath('ocr.py'), '--serve'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Installed machines may have no Python at all: spawn then fails with ENOENT
  // ('exit' never fires) and queued stdin writes error out. Handle both or
  // the unhandled stream error kills the whole app; jobs fall back to
  // Windows OCR via runOcr's catch.
  ocrProc.on('error', err => {
    ocrProc = null;
    failAll(err);
  });
  ocrProc.stdin.on('error', () => {});
  ocrProc.on('exit', () => {
    ocrProc = null;
    if (ocrJob) {
      const job = ocrJob;
      ocrJob = null;
      job.reject(new Error('PaddleOCR worker exited unexpectedly'));
    }
    // Worker died: queued jobs fail over to Windows OCR via runOcr's catch.
    failAll(new Error('PaddleOCR worker exited'));
    pumpOcrQueue();
  });
  return ocrProc;
}

function pumpOcrQueue() {
  if (ocrJob || !ocrQueue.length) return;

  const job = ocrQueue.shift();
  // Hold our own reference: the global can be nulled by a spawn error while
  // this job is in flight, and the finish handler must not crash on it.
  const proc = ensureOcrProc();

  let buf = '';
  let stderr = '';
  let done = false;

  const finish = (err, words) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    proc.stdout.removeListener('data', onData);
    proc.stderr.removeListener('data', onStderr);
    if (ocrJob === job) ocrJob = null;
    if (err) job.reject(err);
    else job.resolve(words);
    pumpOcrQueue();
  };

  const onData = chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    try {
      const parsed = JSON.parse(buf.slice(0, nl));
      if (parsed.error) throw new Error(parsed.error);
      const words = [];
      for (const line of parsed.lines || []) for (const w of line.words || []) words.push(w);
      finish(null, words);
    } catch (e) {
      finish(new Error('Bad OCR output: ' + e.message));
    }
  };
  const onStderr = chunk => { stderr += chunk; };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onStderr);
  ocrJob = job;
  proc.stdin.on('error', () => {});
  proc.stdin.write(job.tmp + '\n');

  // Safety valve: never leave the queue stuck on a hung worker.
  const timer = setTimeout(() => {
    finish(new Error('PaddleOCR timed out' + (stderr ? ': ' + stderr.trim() : '')));
  }, 20000);
}

function failAll(err) {
  if (ocrJob) {
    const job = ocrJob;
    ocrJob = null;
    job.reject(err);
  }
  while (ocrQueue.length) ocrQueue.shift().reject(err);
}

// Fallback: Tesseract.js. Worker is created lazily so startup stays instant.
async function tesseractOcr(pngBuf) {
  if (!tesseractWorker) tesseractWorker = await Tesseract.createWorker('eng');

  // In tesseract.js v7 word bounding boxes only come back when `blocks` is
  // requested (data.blocks -> paragraphs -> lines -> words); it is off by default.
  const { data } = await tesseractWorker.recognize(pngBuf, {}, { blocks: true });

  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          if (w.text.trim() && w.confidence > 30) {
            words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
          }
        }
      }
    }
  }
  return words;
}

async function runOcr(pngBuf) {
  // Order: PaddleOCR (best accuracy) -> Windows OCR (fast, always present)
  // -> Tesseract (pure-JS last resort).
  try {
    const words = await paddleOcr(pngBuf);
    if (words.length) {
      console.log(`PaddleOCR: ${words.length} words`);
      return words;
    }
    console.warn('PaddleOCR found no text; trying Windows OCR.');
  } catch (err) {
    console.warn('PaddleOCR failed, trying Windows OCR:', err.message);
  }
  try {
    const words = await windowsOcr(pngBuf);
    if (words.length) {
      console.log(`Windows OCR: ${words.length} words`);
      return words;
    }
    console.warn('Windows OCR found no text; falling back to Tesseract.');
  } catch (err) {
    console.warn('Windows OCR failed, falling back to Tesseract:', err.message);
  }
  return tesseractOcr(pngBuf);
}

// ---------------------------------------------------------------------------

// Grab a fresh full-screen screenshot at the display's PHYSICAL resolution
// (DIPs x scaleFactor). Requesting CSS-pixel size makes Windows hand back a
// downscaled image: OCR gets a blurry input and the word boxes land slightly
// off, so selections grab the wrong words.
async function captureScreen() {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.size.width * primary.scaleFactor),
      height: Math.round(primary.size.height * primary.scaleFactor),
    },
  });
  if (!sources.length) throw new Error('No screen sources available.');

  const src = sources.find(s => s.display_id === String(primary.id)) || sources[0];

  // The chosen source can belong to a display other than the primary one, so
  // resolve its own display for the overlay geometry and the coordinate mapping.
  const display = screen.getAllDisplays().find(d => String(d.id) === src.display_id) || primary;
  const pngBuf = src.thumbnail.toPNG();

  // Map OCR coordinates to FRACTIONS of the capture (0-1) instead of DIPs.
  // The overlay window gets clamped by Windows (display 1536x864 -> actual
  // content 1540x817 with a taskbar), and the screenshot stretches to fill
  // whatever size the window ends up with. Fractions of the image ==
  // percentages of the rendered <img>, so boxes can never drift off text.
  const size = src.thumbnail.getSize();
  return {
    pngBuf,
    image: 'data:image/png;base64,' + pngBuf.toString('base64'),
    display,
    iw: size.width || 1,
    ih: size.height || 1,
  };
}

// Turn a raw OCR word list (captured-image pixels) into fraction-space words
// clustered into visual rows: a word joins the current row when its vertical
// center sits inside the row's y-range. Reading order is then simply row by
// row, left to right. (Tesseract's own line grouping often splits
// visually-adjacent text across blocks, so we rebuild rows here.)
function layoutWords(raw, iw, ih) {
  const words = raw
    .filter(w => w.text.trim())
    .map(w => ({
      text: w.text,
      x0: w.x0 / iw,
      y0: w.y0 / ih,
      x1: w.x1 / iw,
      y1: w.y1 / ih,
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  let rowTop = -1, rowBottom = -1, li = -1;
  for (const w of words) {
    const cy = (w.y0 + w.y1) / 2;
    if (li === -1 || cy < rowTop || cy > rowBottom) {
      li++;
      rowTop = w.y0;
      rowBottom = w.y1;
    } else {
      rowTop = Math.min(rowTop, w.y0);
      rowBottom = Math.max(rowBottom, w.y1);
    }
    w.line = li;
  }
  return words;
}

let refreshing = false;

// Scroll mode return path: the overlay was hidden so the user could scroll
// their real window. Ctrl+Shift+X brings it back with a FRESH screenshot of
// whatever is on screen now. Chips collected earlier are untouched - they
// live in the renderer and survive the new 'init'.
async function refreshOverlay() {
  if (refreshing) return;
  refreshing = true;
  const seq = ++captureSeq; // from here on, any older OCR result is stale
  try {
    // Hide BEFORE capturing: a visible overlay would be photographed instead
    // of the user's (freshly scrolled) content.
    overlay.hide();
    const frame = await captureScreen();
    if (!overlay || overlay.isDestroyed()) return;
    overlay.show();
    overlay.focus();
    overlay.webContents.send('init', { image: frame.image, words: [] });
    try {
      const words = layoutWords(await runOcr(frame.pngBuf), frame.iw, frame.ih);
      if (seq === captureSeq && overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('boxes', words);
      }
    } catch (ocrErr) {
      console.error('OCR failed after recapture:', ocrErr);
      // Never leave "Reading text..." stuck on screen with no boxes coming.
      if (seq === captureSeq && overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('boxes', []);
      }
    }
    console.log('Recaptured the scrolled screen.');
  } catch (err) {
    console.error('Recapture failed:', err);
    // Fall back to the old screenshot rather than stranding a hidden overlay.
    if (overlay && !overlay.isDestroyed()) overlay.show();
  } finally {
    refreshing = false;
  }
}

async function startCapture() {
  // Ctrl+Shift+X while the overlay exists: if it's hidden (scroll mode),
  // re-capture the freshly scrolled screen and swap the background; if it's
  // visible, stay a no-op so the user can keep selecting.
  if (overlay && !overlay.isDestroyed()) {
    if (!overlay.isVisible()) refreshOverlay();
    return;
  }
  if (busy) return;
  busy = true;
  const seq = ++captureSeq; // supersede any OCR still running for an old capture

  try {
    const { pngBuf, image, display, iw, ih } = await captureScreen();

    // Open the overlay IMMEDIATELY with the frozen screenshot; OCR finishes
    // in the background and word boxes are sent by a follow-up 'boxes' event.
    // The old flow blocked the overlay open on OCR, costing ~3-6s of visible
    // lag between the hotkey press and any feedback.
    overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.on('closed', () => { overlay = null; busy = false; });

    overlay.loadFile(path.join(__dirname, 'overlay.html'));
    overlay.webContents.once('did-finish-load', () => {
      overlay.webContents.send('init', { image, words: [] });
      overlay.webContents.send('setMode', chipMode);
      overlay.focus();
    });

    const words = layoutWords(await runOcr(pngBuf), iw, ih);

    // Overlay may have been closed (Esc) while OCR was running, or the user
    // may have scrolled + recaptured already - only the latest capture wins.
    if (seq === captureSeq && overlay && !overlay.isDestroyed()) {
      overlay.webContents.send('boxes', words);
    }
  } catch (err) {
    console.error('Capture failed:', err);
    busy = false;
    closeOverlay();
  }
}

function closeOverlay() {
  if (overlay) overlay.close();
}

ipcMain.on('selected', async (_, text) => {
  // Single-select: one drag -> copy -> close.
  if (text) {
    try {
      await clipboard.writeText(text);
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  }
  closeOverlay();
});

ipcMain.on('setMode', (_, m) => { chipMode = !!m; });

ipcMain.on('copyAll', async (_, text) => {
  if (!text) return;
  try {
    await clipboard.writeText(text);
  } catch (err) {
    console.error('Clipboard write failed:', err);
  }
  closeOverlay();
});

ipcMain.on('cancel', closeOverlay);

// Scroll mode: hide the overlay so the user can scroll their real window.
// Ctrl+Shift+X brings it back with a fresh screenshot (see refreshOverlay).
ipcMain.on('scrollMode', () => {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.hide();
  console.log('Scroll mode: overlay hidden. Scroll your page, then press Ctrl+Shift+X to recapture.');
});
