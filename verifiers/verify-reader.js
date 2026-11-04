#!/usr/bin/env node
// Verify the read-aloud feature in a built breakdown.html using a fake speechSynthesis.
// Usage: node verifiers/verify-reader.js <breakdown-dir>
// Exit 0 = all checks pass.

const path = require('path');
const puppeteer = require('puppeteer');

const FAKE_SYNTH = () => {
  // Records spoken text; "speaks" each utterance when the test calls window.__finish().
  const spoken = [];
  let current = null;
  window.__spoken = spoken;
  window.__finish = () => { const u = current; current = null; if (u && u.onend) u.onend({}); };
  const synth = {
    speaking: false,
    getVoices: () => [{ name: 'Fake', lang: 'en-US', voiceURI: 'fake' }],
    addEventListener() {},
    cancel() { const u = current; current = null; if (u && u.onerror) u.onerror({ error: 'canceled' }); },
    speak(u) { current = u; spoken.push(u.text); },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
};

const checks = [];
const check = (name, ok, detail) => { checks.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`); };

async function open(browser, file, withSynth) {
  const page = await browser.newPage();
  if (withSynth) await page.evaluateOnNewDocument(FAKE_SYNTH);
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await page.goto('file://' + file, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  return page;
}

(async () => {
  const dir = path.resolve(process.argv[2] || '.');
  const file = path.join(dir, 'breakdown.html');
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await open(browser, file, true);

    const info = await page.evaluate(() => {
      const r = window.AristotleReader;
      return {
        units: r.units.length,
        chapters: new Set(r.units.map((u) => u.chapter)).size,
        buttons: document.querySelectorAll('.ra-play').length,
        text: r.units.map((u) => u.chunks.map((c) => c.text).join(' ')).join(' '),
        maxChunk: Math.max(...r.units.flatMap((u) => u.chunks.map((c) => c.text.length))),
        barHidden: document.querySelector('.ra-bar').hidden,
      };
    });
    check('units built', info.units > info.chapters && info.chapters > 0, JSON.stringify(info));
    check('a play button per unit', info.buttons === info.units, `${info.buttons} vs ${info.units}`);
    check('chunks stay short', info.maxChunk <= 200, `max ${info.maxChunk}`);
    check('canvas/script text not read', !/getContext|rough\.canvas|function\s*\(/.test(info.text), 'code leaked into text');
    check('bar hidden until reading starts', info.barHidden, '');

    // Start from the 3rd chapter's first section.
    const second = await page.evaluate(() => {
      const r = window.AristotleReader;
      const idx = r.units.findIndex((u) => u.chapter === 2);
      r.playFrom(idx);
      return { expect: r.units[idx].chunks[0].text, spoken: window.__spoken.slice() };
    });
    check('start from chapter 3 speaks its title first', second.spoken.length === 1 && second.spoken[0] === second.expect, JSON.stringify(second));

    const adv = await page.evaluate(() => {
      const r = window.AristotleReader;
      const u = r.units.find((x) => x.chapter === 2);
      for (let i = 0; i < u.chunks.length; i++) window.__finish();   // finish whole first unit
      const next = r.units[r.units.indexOf(u) + 1];
      return { spoken: window.__spoken[window.__spoken.length - 1], expect: next.chunks[0].text, barShown: !document.querySelector('.ra-bar').hidden,
               highlighted: document.querySelectorAll('.ra-reading').length };
    });
    check('continues into next section', adv.spoken === adv.expect, JSON.stringify(adv));
    check('bar shown + one element highlighted', adv.barShown && adv.highlighted === 1, JSON.stringify(adv));

    const ctl = await page.evaluate(() => {
      const r = window.AristotleReader;
      const before = window.__spoken.length;
      r.pause(); const paused = r.status().playing;
      r.resume(); const resumed = r.status().playing && window.__spoken.length === before + 1;
      r.setRate(1.5); const rate = r.status().rate;
      r.stop();
      return { paused, resumed, rate, stopped: !r.status().playing, barHidden: document.querySelector('.ra-bar').hidden };
    });
    check('pause/resume/speed/stop', !ctl.paused && ctl.resumed && ctl.rate === 1.5 && ctl.stopped && ctl.barHidden, JSON.stringify(ctl));

    const end = await page.evaluate(() => {
      const r = window.AristotleReader;
      r.playFrom(r.units.length - 1);
      const n = r.units[r.units.length - 1].chunks.length;
      for (let i = 0; i < n; i++) window.__finish();
      return { playing: r.status().playing };
    });
    check('stops after the last section', !end.playing, JSON.stringify(end));
    await page.close();

    const bare = await open(browser, file, false);
    const hasApi = await bare.evaluate(() => !!window.speechSynthesis);
    const ui = await bare.evaluate(() => document.querySelectorAll('.ra-play, .ra-bar').length);
    if (!hasApi) check('no UI when speech API is missing', ui === 0, `${ui} elements`);
    else console.log('SKIP no-API check (headless browser has speechSynthesis)');
  } finally {
    await browser.close();
  }
  process.exit(checks.every(Boolean) ? 0 : 1);
})();
