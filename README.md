# Lens Text 🔍

> **Select and copy text from anywhere on your screen with `Ctrl+Shift+X`.**

Lens Text is a fast, lightweight Windows desktop tool built with Electron that brings Google Lens / Apple Live Text functionality to your PC. Freeze your screen at native resolution, drag over any text (images, videos, PDFs, games, non-selectable UI, error dialogs), and instantly copy it to your clipboard.

---

## ✨ Features

- ⚡ **Instant Global Shortcut (`Ctrl+Shift+X`)**: Tap the hotkey anywhere in Windows to freeze the screen and start selecting.
- 🎯 **Triple-Engine OCR Cascade**:
  1. **RapidOCR / PP-OCRv4 (ONNX)**: Persistent background Python worker for state-of-the-art accuracy and sub-second inference.
  2. **Windows WinRT OCR**: Built-in Windows 10/11 hardware-accelerated OCR (`Windows.Media.Ocr`) via PowerShell fallback. Zero model downloads needed!
  3. **Tesseract.js**: Pure JavaScript offline fallback to guarantee recognition anywhere.
- 📐 **High-DPI & Multi-Monitor Aware**: Captures at exact physical display resolution (`scaleFactor` aware) and normalizes word boxes into fractional coordinate space, ensuring bounding boxes never drift off text.
- 🔀 **Two Selection Modes**:
  - **Single Mode**: Click & drag across text $\rightarrow$ automatically copies to clipboard and closes the overlay.
  - **Multi Mode**: Collect multiple distinct snippets across the screen into interactive chips, then copy all at once.
- 📜 **Scroll Mode (`S`)**: Need text across multiple pages or scrollable containers? Press `S` to hide the overlay, scroll your document, and press `Ctrl+Shift+X` again to recapture—your previously collected chips stay intact!
- 🎨 **Modern Glassmorphic UI**: Translucent, draggable floating HUD and chip drawer inspired by macOS / Windows 11 Fluent Design. Both toolbars can be dragged away if they cover what you want to read.
- 🗂️ **System Tray & Auto-Launch**: Runs quietly in the notification area with auto-start on login so the hotkey is always ready.

---

## ⌨️ Shortcuts & Controls

| Shortcut / Action | Description |
| :--- | :--- |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>X</kbd> | Freeze screen & open text selection overlay (or recapture when in scroll mode) |
| **Click & Drag** | Marquee selection over words or paragraphs |
| <kbd>S</kbd> | Enter **Scroll Mode** (temporarily hides overlay so you can scroll underneath) |
| <kbd>Enter</kbd> | **Copy All** collected chips to clipboard (in Multi Mode) |
| <kbd>Esc</kbd> | Cancel / close the overlay |
| **Drag Toolbar / Chip Card** | Move floating glass HUDs out of the way |

---

## 📥 Installation

### Pre-built Installer
Download the latest `LensText-Setup-1.0.0.exe` installer from the [Releases](https://github.com/saurabhkushwaha438/lens_text/releases) tab.

1. Run the `.exe` installer.
2. Lens Text will start minimized to your system tray.
3. Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>X</kbd> anytime to select text!

> **Optional for enhanced accuracy**: If you have Python installed, install RapidOCR for the PP-OCRv4 engine:
> ```bash
> pip install rapidocr-onnxruntime
> ```
> *Note: If Python is not installed, Lens Text seamlessly uses Windows 10/11's built-in OCR.*

---

## 🛠️ Development & Building from Source

### Prerequisites
- Node.js (v18 or newer recommended)
- Windows 10 or 11 (PowerShell 5.1+ included by default)
- (Optional) Python 3.8+ with `rapidocr-onnxruntime`

### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/saurabhkushwaha438/lens_text.git
   cd lens_text
   ```

2. **Install Node dependencies**:
   ```bash
   npm install
   ```

3. **Run in development mode**:
   ```bash
   npm start
   ```

4. **Build the Windows Installer (.exe)**:
   ```bash
   npm run dist
   ```
   The generated NSIS setup installer will be placed in the `dist/` directory (e.g. `dist/LensText-Setup-1.0.0.exe`).

5. **Verify the packaged build**:
   ```bash
   node verify-dist.js
   ```

---

## 🏗️ Architecture & Project Structure

```text
lens_text/
├── main.js             # Electron main process (hotkeys, capture, tray, OCR routing)
├── preload.js          # IPC bridge exposing secure API to the renderer
├── overlay.html        # Glassmorphic transparent overlay UI and interaction logic
├── ocr.ps1             # Windows.Media.Ocr WinRT engine bridge via PowerShell
├── ocr.py              # RapidOCR / PP-OCRv4 persistent daemon server
├── build/              # Icons and build metadata
│   ├── icon.ico
│   └── icon.png
├── assets/             # Runtime assets (tray icons, etc.)
├── verify-dist.js      # Post-build verification script for unpacked binaries
└── package.json        # Dependencies and electron-builder NSIS configuration
```

### How OCR Routing Works
When a capture is triggered:
1. `desktopCapturer` snaps the full screen at physical display resolution.
2. The overlay window opens immediately with the frozen screenshot so there is zero visible delay.
3. The image is passed to `runOcr()`:
   - **Step 1**: Tries the persistent `ocr.py --serve` worker (PP-OCRv4).
   - **Step 2**: If Python or RapidOCR is unavailable, fails over to `ocr.ps1` (native Windows OCR).
   - **Step 3**: If neither is available, falls back to `tesseract.js` worker.
4. Word bounding boxes are normalized to fractional coordinates (`0.0` - `1.0`) and clustered into reading rows, sent to `overlay.html` to enable precision snapping and drag selection.

