// Read-aloud for breakdown.html — inlined by build-book.sh.
// Uses the browser's Web Speech API (speechSynthesis); no network, no deps.
//
// Book model: one unit per chapter intro and per <h2> section. Each unit is a
// list of chunks (a sentence-sized piece of text plus the element it came from).
(function () {
  'use strict';

  var MAX_CHUNK = 180;            // Chrome drops utterances much longer than this
  var VOICE_WAIT_MS = 1500;       // how long to wait for voices before giving up
  var SKIP = 'canvas, script, style, pre, .back-to-top, .ra-play';
  var BLOCKS = 'h1, h2, h3, h4, p, li, dt, dd, tr, .caption';
  var NESTED = 'ul, ol, p, table, blockquote, ' + SKIP;
  var STORE_KEY = 'aristotle-reader';

  // ---------- text extraction ----------

  function mathText(math) {
    var m = math.querySelector('.katex-mathml math');
    if (!m) return 'equation';
    var c = m.cloneNode(true);
    c.querySelectorAll('annotation').forEach(function (a) { a.remove(); });
    return (c.textContent || '').trim() || 'equation';
  }

  // Text of `el`, math spoken as its MathML text, optionally minus nested blocks.
  function textOf(el, ownOnly) {
    var c = el.cloneNode(true);
    c.querySelectorAll(SKIP).forEach(function (n) { n.remove(); });
    if (ownOnly) c.querySelectorAll('ul, ol, p, table, blockquote').forEach(function (n) { n.remove(); });
    c.querySelectorAll('.katex-display, .katex').forEach(function (k) {
      if (!k.isConnected) return;
      var t = document.createTextNode(' ' + mathText(k) + ' ');
      k.replaceWith(t);
    });
    return c.textContent.replace(/\s+/g, ' ').trim();
  }

  function blockText(el) {
    if (el.matches('tr')) {
      return Array.prototype.map.call(el.children, function (cell) { return textOf(cell); })
        .filter(Boolean).join(', ');
    }
    if (el.matches('li')) return textOf(el, true);
    return textOf(el);
  }

  // Split long text at sentence ends so each utterance stays short.
  function splitText(text) {
    if (text.length <= MAX_CHUNK) return [text];
    var sentences = text.match(/[^.!?;:]+[.!?;:]*\s*/g) || [text];
    var out = [], cur = '';
    sentences.forEach(function (s) {
      if (cur && (cur + s).length > MAX_CHUNK) { out.push(cur.trim()); cur = ''; }
      cur += s;
    });
    if (cur.trim()) out.push(cur.trim());
    // A single sentence can still be too long: break at spaces.
    return out.flatMap(function (p) {
      var parts = [];
      while (p.length > MAX_CHUNK) {
        var cut = p.lastIndexOf(' ', MAX_CHUNK);
        if (cut < 1) cut = MAX_CHUNK;
        parts.push(p.slice(0, cut).trim());
        p = p.slice(cut);
      }
      if (p.trim()) parts.push(p.trim());
      return parts;
    });
  }

  function buildUnits(root) {
    var units = [];
    root.querySelectorAll('section.chapter').forEach(function (chapter, ci) {
      var h1 = chapter.querySelector('h1');
      var chapterTitle = h1 ? h1.textContent.replace(/^\s*▶\s*/, '').trim() : 'Chapter ' + (ci + 1);
      var unit = null;
      function start(title, heading) {
        unit = { chapter: ci, chapterTitle: chapterTitle, title: title, heading: heading, chunks: [] };
        units.push(unit);
      }
      start(chapterTitle, h1);

      chapter.querySelectorAll(BLOCKS).forEach(function (el) {
        if (el.closest(SKIP)) return;
        if (el.matches('h1')) { return; }
        if (el.matches('h2')) {
          var t = textOf(el);
          start(t, el);
          unit.chunks.push({ el: el, text: t });
          return;
        }
        // li/tr that contain their own blocks are read through those blocks
        if (el.matches('li') && el.querySelector(':scope > p')) return;
        var text = blockText(el);
        if (!text) return;
        splitText(text).forEach(function (piece) { unit.chunks.push({ el: el, text: piece }); });
      });
      // Chapter title is the first thing spoken for the intro unit.
      units[units.findIndex(function (u) { return u.chapter === ci; })]
        .chunks.unshift({ el: h1, text: chapterTitle });
    });
    return units.filter(function (u) { return u.chunks.length; });
  }

  // ---------- voices ----------

  // Names that usually mean a neural / high-quality voice.
  var GOOD_VOICE = /natural|neural|premium|enhanced|piper|siri|google/i;

  function pageLang() { return (document.documentElement.lang || 'en').toLowerCase(); }

  // Some systems expose tens of thousands of voices (every eSpeak language and
  // variant, per engine). Keep the ones for the book's language, drop "Name+Variant"
  // clones, and list likely-good voices first.
  function voiceChoices(all) {
    var lang = pageLang().slice(0, 2);
    var list = all.filter(function (v) {
      return v.lang.toLowerCase().indexOf(lang) === 0 && v.name.indexOf('+') < 0;
    });
    if (!list.length) list = all.slice(0, 50);
    return list.sort(function (a, b) {
      var ga = GOOD_VOICE.test(a.name) ? 0 : 1, gb = GOOD_VOICE.test(b.name) ? 0 : 1;
      return ga - gb || a.name.localeCompare(b.name);
    });
  }

  // ---------- player ----------

  function create(root, synth, Utterance) {
    var units = buildUnits(root);
    var state = { unit: 0, chunk: 0, playing: false, token: 0 };
    var prefs = load();
    var voices = [];
    var listeners = [];
    var lit = null;

    function load() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
    }
    function save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
    }
    function emit() { listeners.forEach(function (fn) { fn(api.status()); }); }

    function highlight(el) {
      if (lit) lit.classList.remove('ra-reading');
      lit = el;
      if (el) {
        el.classList.add('ra-reading');
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    function pickVoice() {
      if (!prefs.voiceURI) return api.autoVoice();
      return voices.filter(function (v) { return v.voiceURI === prefs.voiceURI; })[0] || api.autoVoice();
    }

    function speak() {
      var u = units[state.unit];
      var c = u && u.chunks[state.chunk];
      if (!c) return stop();
      var token = ++state.token;
      synth.cancel();
      highlight(c.el);
      var ut = new Utterance(c.text);
      ut.rate = prefs.rate || 1;
      var v = pickVoice();
      if (v) { ut.voice = v; ut.lang = v.lang; }
      else ut.lang = pageLang();   // lets the browser pick a voice for the book's language
      ut.onend = function () { if (token === state.token && state.playing) advance(); };
      ut.onerror = function (e) {
        if (token !== state.token) return;
        if (e && (e.error === 'canceled' || e.error === 'interrupted')) return;
        state.playing = false; emit();
      };
      synth.speak(ut);
      emit();
    }

    function advance() {
      var u = units[state.unit];
      if (state.chunk + 1 < u.chunks.length) { state.chunk++; return speak(); }
      if (state.unit + 1 < units.length) { state.unit++; state.chunk = 0; return speak(); }
      stop();
    }

    function stop() {
      state.token++;
      state.playing = false;
      synth.cancel();
      highlight(null);
      emit();
    }

    var api = {
      units: units,
      // Start reading at the unit whose heading is `heading` (or unit index).
      playFrom: function (target) {
        var i = typeof target === 'number' ? target : units.findIndex(function (u) { return u.heading === target; });
        if (i < 0) return;
        state.unit = i; state.chunk = 0; state.playing = true; speak();
      },
      pause: function () {            // cancel + remember position; resume re-speaks the chunk
        if (!state.playing) return;
        state.token++; state.playing = false; synth.cancel(); emit();
      },
      resume: function () { state.playing = true; speak(); },
      toggle: function () { state.playing ? api.pause() : api.resume(); },
      next: function () {
        if (state.unit + 1 >= units.length) return stop();
        state.unit++; state.chunk = 0; state.playing = true; speak();
      },
      prev: function () {
        // First press restarts the section, second goes to the previous one.
        if (state.chunk > 0 || state.unit === 0) state.chunk = 0; else state.unit--, state.chunk = 0;
        state.playing = true; speak();
      },
      stop: stop,
      setRate: function (r) {
        prefs.rate = r; save();
        if (state.playing) speak(); else emit();
      },
      setVoice: function (uri) {
        prefs.voiceURI = uri; save();
        if (state.playing) speak(); else emit();
      },
      setVoices: function (list) { voices = list; emit(); },
      voices: function () { return voices; },
      // Voices usable for the book's language, best-sounding first.
      voiceChoices: function () { return voiceChoices(voices); },
      // Best-sounding voice for the book's language, if one is recognisable by name.
      autoVoice: function () { return voiceChoices(voices).filter(function (v) { return GOOD_VOICE.test(v.name); })[0] || null; },
      prefs: function () { return prefs; },
      onChange: function (fn) { listeners.push(fn); },
      status: function () {
        var u = units[state.unit];
        return { playing: state.playing, active: !!lit || state.playing, unit: state.unit,
                 chunk: state.chunk, title: u && u.title, chapterTitle: u && u.chapterTitle,
                 chapter: u && u.chapter, rate: prefs.rate || 1, voiceURI: prefs.voiceURI || '' };
      },
    };
    return api;
  }

  // ---------- UI ----------

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text) n.textContent = text;
    return n;
  }

  function mountUI(reader) {
    var bar = el('div', { class: 'ra-bar', role: 'region', 'aria-label': 'Read aloud', hidden: '' });
    var label = el('div', { class: 'ra-label' });
    var controls = el('div', { class: 'ra-controls' });
    function btn(txt, title, fn) {
      var b = el('button', { type: 'button', title: title, 'aria-label': title }, txt);
      b.addEventListener('click', fn);
      controls.appendChild(b);
      return b;
    }
    btn('⏮', 'Previous section', reader.prev);
    var playBtn = btn('⏸', 'Pause', reader.toggle);
    btn('⏭', 'Next section', reader.next);
    btn('⏹', 'Stop', reader.stop);
    var rate = el('select', { 'aria-label': 'Speed' });
    [0.75, 1, 1.25, 1.5, 1.75, 2].forEach(function (r) { rate.appendChild(el('option', { value: r }, r + '×')); });
    rate.addEventListener('change', function () { reader.setRate(parseFloat(rate.value)); });
    var voice = el('select', { 'aria-label': 'Voice' });
    voice.addEventListener('change', function () { reader.setVoice(voice.value); });
    controls.appendChild(rate);
    controls.appendChild(voice);
    bar.appendChild(label);
    bar.appendChild(controls);
    document.body.appendChild(bar);

    function fillVoices() {
      var auto = reader.autoVoice();
      voice.textContent = '';
      voice.appendChild(el('option', { value: '' }, auto ? 'Auto (' + auto.name + ')' : 'Default voice'));
      reader.voiceChoices().forEach(function (v) {
        voice.appendChild(el('option', { value: v.voiceURI }, v.name + ' (' + v.lang + ')'));
      });
      voice.value = reader.prefs().voiceURI || '';
    }

    reader.onChange(function (s) {
      bar.hidden = !s.active;
      playBtn.textContent = s.playing ? '⏸' : '▶';
      playBtn.title = playBtn.ariaLabel = s.playing ? 'Pause' : 'Resume';
      label.textContent = s.title && s.title !== s.chapterTitle
        ? 'Ch ' + (s.chapter + 1) + ' › ' + s.title : s.chapterTitle || '';
      rate.value = String(s.rate);
      if (voice.options.length <= 1) fillVoices();
      if (s.playing) wakeLock(true); else wakeLock(false);
      mediaSession(s);
    });

    // ▶ before every chapter and section heading
    reader.units.forEach(function (u) {
      if (!u.heading || u.heading.querySelector('.ra-play')) return;
      var b = el('button', { type: 'button', class: 'ra-play', title: 'Read aloud from here', 'aria-label': 'Read aloud from here' }, '▶');
      b.addEventListener('click', function () { reader.playFrom(u.heading); });
      u.heading.insertBefore(b, u.heading.firstChild);
    });
    document.body.classList.add('ra-ready');
  }

  var lock = null;
  function wakeLock(on) {
    try {
      if (on && !lock && navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) { lock = l; l.addEventListener('release', function () { lock = null; }); }, function () {});
      } else if (!on && lock) { lock.release(); lock = null; }
    } catch (e) { /* unsupported */ }
  }

  var msBound = false;
  function mediaSession(s) {
    try {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: s.title || '', artist: s.chapterTitle || '', album: document.title });
      navigator.mediaSession.playbackState = s.playing ? 'playing' : 'paused';
      if (msBound) return;
      msBound = true;
      var r = window.AristotleReader;
      [['play', r.resume], ['pause', r.pause], ['nexttrack', r.next], ['previoustrack', r.prev]].forEach(function (h) {
        navigator.mediaSession.setActionHandler(h[0], h[1]);
      });
    } catch (e) { /* unsupported */ }
  }

  function init() {
    var synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return;
    var reader = create(document.body, synth, window.SpeechSynthesisUtterance);
    window.AristotleReader = reader;
    if (!reader.units.length) return;

    var shown = false;
    function ready(list) {
      if (shown) return;
      shown = true;
      reader.setVoices(list);
      mountUI(reader);
    }
    function poll() {
      var list = synth.getVoices();
      if (list.length) ready(list);
      return list.length > 0;
    }
    if (poll()) return;
    synth.addEventListener && synth.addEventListener('voiceschanged', poll);
    setTimeout(function () {
      if (shown) return;
      var note = el('div', { class: 'ra-note' }, 'Read aloud is unavailable: this device has no speech voices.');
      document.body.appendChild(note);
      setTimeout(function () { note.remove(); }, 6000);
    }, VOICE_WAIT_MS);
  }

  // Exposed for verifiers.
  window.AristotleReaderInternals = { buildUnits: buildUnits, splitText: splitText, create: create };

  // Registered after the KaTeX render handler, so math is already typeset.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
