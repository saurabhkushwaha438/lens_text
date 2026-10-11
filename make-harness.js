// Generates harness.generated.html from overlay.html for behavior testing.
// Usage: node make-harness.js
const fs = require('fs');

const overlay = fs.readFileSync('overlay.html', 'utf8');

const stub = `<script>
(function () {
  window.__calls = [];
  const rec = (name, a) => window.__calls.push([name, typeof a === 'function' ? '[fn]' : a]);
  window.api = {
    onInit: cb => { window.__init = cb; },
    onBoxes: cb => { window.__boxes = cb; },
    onMode: cb => { window.__onMode = cb; },
    done: t => rec('done', t),
    cancel: () => rec('cancel'),
    scroll: () => rec('scroll'),
    setMode: m => rec('setMode', m),
    multiAppend: t => rec('multiAppend', t),
    copyAll: t => rec('copyAll', t),
    clearChips: cb => { window.__clearChips = cb; },
  };
})();
</script>`;

const runner = `<script>
window.__runTests = function () {
  const out = [];
  const assert = (name, cond, detail) => out.push({ name, pass: !!cond, detail: String(detail) });
  const fire = (el, type, opts) =>
    el.dispatchEvent(new (type.indexOf('key') === 0 ? KeyboardEvent : MouseEvent)(
      type, Object.assign({ bubbles: true, cancelable: true }, opts)));
  const ev = (x, y) => ({ clientX: x, clientY: y });
  const $ = s => document.querySelector(s);
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  try {
    // 1. boot with words; no empty bar at the bottom before any chip exists
    window.__calls.length = 0;
    window.__init({
      image: GIF,
      words: [
        { text: 'Hello',  x0: .10, y0: .20, x1: .25, y1: .28, line: 0 },
        { text: 'world',  x0: .27, y0: .20, x1: .40, y1: .28, line: 0 },
        { text: 'second', x0: .10, y0: .50, x1: .30, y1: .58, line: 1 },
        { text: 'line',   x0: .32, y0: .50, x1: .45, y1: .58, line: 1 },
      ],
    });
    const bar = $('#bottom') || $('#copybar');
    assert('no bar before first chip', bar && (bar.style.display === 'none' || getComputedStyle(bar).display === 'none'),
      bar ? bar.id + '=' + (bar.style.display || getComputedStyle(bar).display) : 'missing');

    // 1b. main pushes the persisted mode after init
    window.__calls.length = 0;
    window.__onMode(true);
    assert('onMode(true) sets Multi', $('#mode-label').textContent === 'Multi', $('#mode-label').textContent);
    window.__onMode(false);
    assert('onMode(false) sets Single', $('#mode-label').textContent === 'Single', $('#mode-label').textContent);

    // 2. single mode still works: drag row 1 -> done(), no chip
    window.__calls.length = 0;
    fire(document.body, 'mousedown', ev(.05 * innerWidth, .15 * innerHeight));
    fire(document.body, 'mousemove', ev(.50 * innerWidth, .35 * innerHeight));
    fire(document.body, 'mouseup',   ev(.50 * innerWidth, .35 * innerHeight));
    let c = window.__calls;
    assert('single mode copies and does not chip', c.some(x => x[0] === 'done' && x[1] === 'Hello world'), JSON.stringify(c));
    assert('single mode adds no chip', document.querySelectorAll('#chips > div').length === 0,
      document.querySelectorAll('#chips > div').length);

    // 3. clicking the mode toggle must NOT act as a text selection
    window.__calls.length = 0;
    fire($('#mode-btn'), 'mousedown', ev(10, 10));
    fire($('#mode-btn'), 'mouseup', ev(10, 10));
    $('#mode-btn').click();
    c = window.__calls;
    assert('toggle click does not fire done()', !c.some(x => x[0] === 'done'), JSON.stringify(c));
    assert('toggle click sends setMode(true)', c.some(x => x[0] === 'setMode' && x[1] === true), JSON.stringify(c));
    assert('mode label is Multi', $('#mode-label').textContent === 'Multi', $('#mode-label').textContent);

    // 4. multi drag row 1 -> chip, overlay stays open
    window.__calls.length = 0;
    fire(document.body, 'mousedown', ev(.05 * innerWidth, .15 * innerHeight));
    fire(document.body, 'mousemove', ev(.50 * innerWidth, .35 * innerHeight));
    fire(document.body, 'mouseup',   ev(.50 * innerWidth, .35 * innerHeight));
    c = window.__calls;
    assert('multi select keeps overlay open', !c.some(x => x[0] === 'done' || x[0] === 'copyAll'), JSON.stringify(c));
    assert('chip 1 added', document.querySelectorAll('#chips > div').length === 1,
      document.querySelectorAll('#chips > div').length);

    // 5. multi drag row 2 -> second chip
    fire(document.body, 'mousedown', ev(.05 * innerWidth, .45 * innerHeight));
    fire(document.body, 'mouseup',   ev(.55 * innerWidth, .65 * innerHeight));
    assert('chip 2 added', document.querySelectorAll('#chips > div').length === 2,
      document.querySelectorAll('#chips > div').length);
    assert('count shows 2', /2/.test($('#copy-count').textContent), $('#copy-count').textContent);
    assert('toggle disabled while chips exist', $('#mode-btn').disabled === true, $('#mode-btn').disabled);

    // 6. clicking Copy all -> exactly the joined chip text, no junk chip
    window.__calls.length = 0;
    fire($('#copy-btn'), 'mousedown', ev(innerWidth - 20, innerHeight - 10));
    fire($('#copy-btn'), 'mouseup', ev(innerWidth - 20, innerHeight - 10));
    $('#copy-btn').click();
    c = window.__calls;
    assert('copyAll joined text', c.some(x => x[0] === 'copyAll' && x[1] === 'Hello world\\nsecond line'),
      JSON.stringify(c));
    assert('copy click adds no junk chip', document.querySelectorAll('#chips > div').length === 2,
      document.querySelectorAll('#chips > div').length);

    // 6b. scroll mode: button and S key hide the overlay via main, never
    // selecting or copying anything
    window.__calls.length = 0;
    fire($('#scroll-btn'), 'mousedown', ev(10, 10));
    fire($('#scroll-btn'), 'mouseup', ev(10, 10));
    $('#scroll-btn').click();
    c = window.__calls;
    assert('scroll button sends scroll', c.some(x => x[0] === 'scroll'), JSON.stringify(c));
    assert('scroll button does not select/copy',
      !c.some(x => x[0] === 'done' || x[0] === 'copyAll'), JSON.stringify(c));

    window.__calls.length = 0;
    fire(document.body, 'keydown', { key: 's' });
    assert('S key sends scroll', window.__calls.some(x => x[0] === 'scroll'), JSON.stringify(window.__calls));

    // 6c. recapture: main re-inits with a fresh screenshot + new words;
    // chips and mode must survive, new words become selectable
    window.__calls.length = 0;
    window.__init({
      image: GIF,
      words: [
        { text: 'third', x0: .10, y0: .75, x1: .30, y1: .85, line: 2 },
      ],
    });
    assert('recapture keeps chips', document.querySelectorAll('#chips > div').length === 2,
      document.querySelectorAll('#chips > div').length);
    assert('recapture keeps count', /2 selected/.test($('#copy-count').textContent),
      $('#copy-count').textContent);
    assert('recapture keeps mode', $('#mode-label').textContent === 'Multi',
      $('#mode-label').textContent);
    fire(document.body, 'mousedown', ev(.05 * innerWidth, .70 * innerHeight));
    fire(document.body, 'mouseup',   ev(.50 * innerWidth, .92 * innerHeight));
    assert('word from new capture chips', document.querySelectorAll('#chips > div').length === 3,
      document.querySelectorAll('#chips > div').length);

    // 6d. Enter copies all chips, including the post-recapture one
    window.__calls.length = 0;
    fire(document.body, 'keydown', { key: 'Enter' });
    assert('Enter copyAll joins all three',
      window.__calls.some(x => x[0] === 'copyAll' && x[1] === 'Hello world\\nsecond line\\nthird'),
      JSON.stringify(window.__calls));

    // 7. chip remove buttons drain the list and re-enable the toggle
    window.__calls.length = 0;
    let removed = 0;
    while (document.querySelector('#chips > div button') && removed < 10) {
      document.querySelector('#chips > div button').click();
      removed++;
    }
    assert('all chips removed', document.querySelectorAll('#chips > div').length === 0,
      document.querySelectorAll('#chips > div').length);
    assert('removed exactly 3', removed === 3, removed);
    assert('toggle re-enabled when chips cleared', $('#mode-btn').disabled === false,
      $('#mode-btn').disabled);
    assert('bottom bar hidden again',
      ($('#bottom').style.display === 'none' || getComputedStyle($('#bottom')).display === 'none'),
      $('#bottom').style.display || getComputedStyle($('#bottom')).display);

    // 8. Esc cancels
    window.__calls.length = 0;
    fire(document.body, 'keydown', { key: 'Escape' });
    assert('Escape sends cancel', window.__calls.some(x => x[0] === 'cancel'), JSON.stringify(window.__calls));
  } catch (e) {
    assert('no exceptions', false, e && (e.stack || e.message || e));
  }
  return out;
};
</script>`;

if (!/<body>/.test(overlay)) throw new Error('overlay.html has no <body>');
const html = overlay.replace('<body>', '<body>\n' + stub)
  .replace('</body>', runner + '\n</body>');
fs.writeFileSync('harness.generated.html', html);
console.log('harness.generated.html written');
