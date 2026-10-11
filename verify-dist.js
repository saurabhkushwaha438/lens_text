// Post-build verification: the packaged app must contain everything the
// runtime needs, and ocr.ps1/ocr.py must be UNPACKED (external processes
// cannot read inside asar).
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');

const RES = 'dist/win-unpacked/resources';
const list = asar.listPackage(path.join(RES, 'app.asar')).map(f => f.replace(/\\/g, '/'));

let fail = 0;
const check = (name, ok, note) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (note ? '  (' + note + ')' : ''));
  if (!ok) fail++;
};

for (const f of ['main.js', 'preload.js', 'overlay.html']) {
  check('asar contains ' + f, list.includes('/' + f) || list.includes(f) ||
    list.some(e => e.endsWith('/' + f)));
}

const unpacked = path.join(RES, 'app.asar.unpacked');
check('unpacked ocr.ps1 exists', fs.existsSync(path.join(unpacked, 'ocr.ps1')));
check('unpacked ocr.py exists', fs.existsSync(path.join(unpacked, 'ocr.py')));
check('unpacked tray icon exists', fs.existsSync(path.join(unpacked, 'assets', 'icon.png')));
check('unpacked tesseract worker exists',
  fs.existsSync(path.join(unpacked, 'node_modules/tesseract.js/dist/worker.min.js')));

// The asar copies must NOT be the only copy of the scripts (they'd be useless
// to PowerShell/Python) - but having them referenced correctly in main.js is
// what matters; verify the packaged main.js uses the unpacked path helper.
const mainSrc = asar.extractFile(path.join(RES, 'app.asar'), 'main.js').toString('utf8');
check('packaged main.js uses resourcePath() for ocr.ps1',
  mainSrc.includes("resourcePath('ocr.ps1')"));
check('packaged main.js uses resourcePath() for ocr.py',
  mainSrc.includes("resourcePath('ocr.py')"));
check('packaged main.js sets AppUserModelId', mainSrc.includes('setAppUserModelId'));
check('packaged main.js has tray setup', mainSrc.includes('setupTray'));

const exe = 'dist/win-unpacked/Lens Text.exe';
check('unpackaged exe exists', fs.existsSync(exe),
  fs.existsSync(exe) ? (fs.statSync(exe).size / 1e6).toFixed(0) + ' MB' : '');
const setup = 'dist/LensText-Setup-1.0.0.exe';
check('NSIS installer exists', fs.existsSync(setup),
  fs.existsSync(setup) ? (fs.statSync(setup).size / 1e6).toFixed(0) + ' MB' : '');

process.exit(fail ? 1 : 0);
