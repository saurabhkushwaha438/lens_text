multi-select mode. Architecture:

- A "mode" toggle on the overlay caption bar (Multi / Single).
- Multi mode keeps the overlay open after mouseup; each drag becomes a "selection chip" in a bottom panel listing the captured text chunks.
- Chips can be added (drag), removed (click X), and reordered (drag chip up/down) — though reordering is optional, keep it simple: just a list you can remove from.
- A "Copy all" button at the bottom joins the chip texts with newlines (in chip order) and copies, then closes the overlay.
- Single mode behaves exactly as today: one drag → copy → close.
- Default mode: Single (so existing behavior is unchanged unless the user opts in).

Implementation sketch:
- main.js: ipcMain handler 'multiDone' (text, append) that appends to a per-capture buffer and keeps overlay open; 'copyAll' handler that joins and copies; 'setMode' handler.
- preload.js: expose `setMode`, `multiAppend(text)`, `copyAll()`, `cancel`.
- overlay.html: caption bar with mode toggle + chip list + Copy all button; JS state for chips array; mouseup in multi mode calls multiAppend and keeps overlay; chip render with remove button.

Keep it minimal: no persistence, no fancy drag reordering, just add/remove/copy.
