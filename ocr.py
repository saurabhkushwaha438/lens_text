"""PaddleOCR (PP-OCRv4 via RapidOCR/ONNX) helper for lens-text.

Usage:
  python ocr.py <image-path>      one-shot (model reloads each run ~6s)
  python ocr.py --serve           persistent worker: read image paths from
                                  stdin, write one JSON payload + \n per line.

Emits the same JSON shape as ocr.ps1 so main.js can swap engines freely:
  { "text": "...", "lines": [ { "text": "...",
      "words": [ { "text", "x0", "y0", "x1", "y1" }, ... ] }, ... ] }

RapidOCR only returns line-level boxes, so each detected line is split into
word boxes proportionally by character count - good enough for hit-testing
words in the selection overlay.
"""
import json
import sys


def split_line(box, text):
    """Split a line-level quad into word rects proportional to token length."""
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)

    tokens = text.split(' ')
    if not tokens:
        return []
    # Character counts include the spaces that were consumed as separators so
    # the widths sum to the full line width.
    weights = [len(t) + 1 for t in tokens]
    weights[-1] = max(1, len(tokens[-1]))
    total = sum(weights) or 1

    words = []
    cursor = x0
    width = x1 - x0
    for tok, w in zip(tokens, weights):
        if not tok:
            cursor += width * w / total
            continue
        wpx = width * w / total
        words.append({
            "text": tok,
            "x0": round(cursor, 2),
            "y0": round(float(y0), 2),
            "x1": round(cursor + wpx, 2),
            "y1": round(float(y1), 2),
        })
        cursor += wpx
    return words


_engine = None


def get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def recognize(path):
    result, _ = get_engine()(path)

    lines_out = []
    for box, text, _score in result or []:
        if not text or not text.strip():
            continue
        words = split_line(box, text.strip())
        if not words:
            continue
        lines_out.append({"text": text.strip(), "words": words})

    return {"text": "\n".join(l["text"] for l in lines_out), "lines": lines_out}


def emit(payload):
    # raw sys.stdout.buffer.write avoids Python's newline translation, which
    # would otherwise corrupt the JSON string escapes on Windows.
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--serve":
        # Persistent mode: keep the model loaded and serve requests from stdin.
        # Startup (~5s) happens once; each subsequent capture costs only
        # inference (~0.5-1s). One JSON payload per line out.
        for line in sys.stdin:
            path = line.strip()
            if not path:
                continue
            try:
                payload = recognize(path)
            except Exception as exc:  # keep serving after a bad image
                payload = {"error": str(exc), "lines": []}
            sys.stdout.buffer.write(
                json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
            )
            sys.stdout.buffer.flush()
        return

    if len(sys.argv) != 2:
        print("usage: ocr.py <image> | ocr.py --serve", file=sys.stderr)
        sys.exit(2)

    emit(recognize(sys.argv[1]))


if __name__ == "__main__":
    main()
