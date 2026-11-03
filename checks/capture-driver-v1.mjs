#!/usr/bin/env node
/* Capture driver for MemoryLoom visual evidence (card S2).
 *
 * Owning file: checks/capture-driver-v1.mjs
 * Accountable layer: browser layer test support
 * Provider need: none. The driver reads no database setting and
 *   holds no key. It drives pages served by the web server, and
 *   that server is the entry point the database gate covers.
 *
 * Usage:
 *   node checks/capture-driver-v1.mjs <steps.json> <outdir>
 *
 * steps.json: { "port": 9333, "steps": [ Step, ... ] }
 * Step kinds:
 *   { "goto": "http://localhost:4173/console#/time", "waitMs": 800 }
 *   { "shot": "name", "width": 1280, "height": 900, "fullPage": false }
 *   { "eval": "js expression", "as": "probeName" }   (result recorded)
 *   { "click": "css selector" }                      (real DOM click)
 *   { "key": "ArrowRight" }                          (one trusted key press on the focused element)
 *   { "type": ["css selector", "text"] }             (focus + value + input events)
 *   { "settle": true }                               (call window.__weave settle hooks if present)
 *   { "waitMs": 500 }
 *   { "inject": "js source" }                        (Page.addScriptToEvaluateOnNewDocument, card S8)
 *   { "focus": "css selector" }                      (move focus without activating, card S8)
 *   { "mclick": "css selector" }                     (trusted mouse click via CDP Input, card S8)
 *   { "key": "Tab" } / { "key": "Shift+Tab" }        (trusted keys, card S8)
 *   { "axtree": true, "as": "name" }                 (accessibility tree snapshot, card S8)
 *   { "emulate": { "reducedMotion": true } }         (prefers-reduced-motion, card S8)
 *   { "pageScale": 2 }                               (page zoom factor, card S8)
 *   { "wheel": ["css selector", 240] }               (trusted wheel over an element, card S8)
 *   { "touchSwipe": ["css selector", -240] }         (trusted touch drag on an element, card S8)
 * Output: <outdir>/<name>.png per shot, <outdir>/walk-report.json with
 * every eval result and step outcome. Exit code 0 iff all steps ran.
 *
 * The driver spawns chrome-headless-shell itself on the given port
 * and kills it at the end. No baseline step depends on a file under
 * a temporary folder. This file is the committed copy of the driver
 * the evidence packs were produced with.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SHELL = process.env.CHROME_HEADLESS_SHELL ||
  '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';

const [stepsPath, outdir] = process.argv.slice(2);
if (!stepsPath || !outdir) { console.error('usage: ml-drive.mjs <steps.json> <outdir>'); process.exit(2); }
const spec = JSON.parse((await import('node:fs')).readFileSync(stepsPath, 'utf8'));
const port = spec.port || 9333;
mkdirSync(outdir, { recursive: true });

const chrome = spawn(SHELL, [
  '--remote-debugging-port=' + port,
  '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitEndpoint() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('chrome debugging endpoint never came up');
}

const report = { startedAt: new Date().toISOString(), steps: [], probes: {} };
let ws, seq = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  const version = await waitEndpoint();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ssend = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  await ssend('Page.enable'); await ssend('Runtime.enable');

  const evaluate = async (expr) => {
    const r = await ssend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  for (const [i, step] of spec.steps.entries()) {
    const rec = { i, kind: Object.keys(step)[0], ok: true };
    try {
      if (step.goto) { await ssend('Page.navigate', { url: step.goto }); await sleep(step.waitMs ?? 700); }
      else if (step.key) {
        // One trusted key press through CDP, so native control
        // behaviour (a range input stepping, Home and End) is the
        // real browser behaviour and not a synthetic event a page
        // could ignore. This branch stands before the waitMs branch
        // so a key step that carries a wait is never read as a wait
        // alone (the card S4 harness lesson).
        const vk = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Enter: 13, ' ': 32, Space: 32, Tab: 9 }[step.key] || 0;
        const shiftTab = step.key === 'Shift+Tab';
        const keyName = shiftTab ? 'Tab' : step.key === 'Space' ? ' ' : step.key;
        const mods = shiftTab ? 8 : 0;
        await ssend('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: keyName === ' ' ? 'Space' : keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
        await ssend('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: keyName === ' ' ? 'Space' : keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
        await sleep(step.waitMs ?? 350);
      }
      else if (step.waitMs) { await sleep(step.waitMs); }
      else if (step.shot) {
        const w = step.width || 1280, h = step.height || 900;
        await ssend('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(150);
        const metrics = step.fullPage
          ? await ssend('Page.getLayoutMetrics')
          : null;
        const cs = metrics?.cssContentSize || metrics?.contentSize;
        const params = { format: 'png', captureBeyondViewport: Boolean(step.fullPage) };
        if (step.fullPage && cs) params.clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale: 1 };
        const { data } = await ssend('Page.captureScreenshot', params);
        const file = `${outdir}/${step.shot}.png`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(data, 'base64'));
        rec.file = file;
      }
      else if (step.eval) { const v = await evaluate(step.eval); if (step.as) report.probes[step.as] = v; rec.value = v; }
      else if (step.click) { await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.click)}); if (!e) throw new Error('no element ' + ${JSON.stringify(step.click)}); e.click(); return true; })()`); await sleep(step.waitMs ?? 400); }
      else if (step.type) {
        const [sel, text] = step.type;
        await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await sleep(step.waitMs ?? 300);
      }
      else if (step.settle) { await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /pause/i.test(x.textContent)); if (b) b.click(); return true; })()`).catch(() => {}); await sleep(300); }
      else if (step.inject) { await ssend('Page.addScriptToEvaluateOnNewDocument', { source: step.inject }); rec.value = 'injected'; }
      else if (step.focus) { await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.focus)}); if (!e) throw new Error('no element ' + ${JSON.stringify(step.focus)}); e.focus(); return document.activeElement === e; })()`); await sleep(step.waitMs ?? 250); }
      else if (step.mclick) {
        const pt = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.mclick)}); if (!e) throw new Error('no element ' + ${JSON.stringify(step.mclick)}); e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await ssend('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await ssend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await sleep(step.waitMs ?? 400);
      }
      else if (step.axtree) {
        await ssend('Accessibility.enable');
        const { nodes } = await ssend('Accessibility.getFullAXTree');
        const slim = (nodes || []).filter((n) => !n.ignored).map((n) => {
          const props = {}; for (const p of n.properties || []) props[p.name] = p.value?.value;
          return { role: n.role?.value, name: n.name?.value || '', value: props.valuetext ?? props.value ?? null, focused: Boolean(props.focused) };
        }).filter((n) => n.name || ['slider', 'textbox', 'alert', 'img'].includes(n.role));
        if (step.as) report.probes[step.as] = slim.slice(0, 400);
        rec.value = slim.length + ' ax nodes';
      }
      else if (step.emulate) {
        const features = step.emulate && step.emulate.reducedMotion !== undefined
          ? [{ name: 'prefers-reduced-motion', value: step.emulate.reducedMotion ? 'reduce' : 'no-preference' }]
          : [];
        await ssend('Emulation.setEmulatedMedia', { media: '', features });
        await sleep(step.waitMs ?? 200);
      }
      else if (step.pageScale) { await ssend('Emulation.setPageScaleFactor', { pageScaleFactor: step.pageScale }); await sleep(step.waitMs ?? 200); }
      else if (step.wheel) {
        const [sel, dy, dx] = step.wheel;
        const pt = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 }; })()`);
        await ssend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: dx || 0, deltaY: dy });
        await sleep(step.waitMs ?? 350);
      }
      else if (step.touchSwipe) {
        const [sel, dx] = step.touchSwipe;
        const pt = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no element ' + ${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await ssend('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
        for (let i = 1; i <= 5; i++) await ssend('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pt.x + (dx * i) / 5, y: pt.y, id: 1 }] });
        await ssend('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(step.waitMs ?? 350);
      }
      else { rec.ok = false; rec.error = 'unknown step'; }
    } catch (e) { rec.ok = false; rec.error = String(e.message || e); }
    report.steps.push(rec);
  }
  await send('Target.closeTarget', { targetId }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${outdir}/walk-report.json`, JSON.stringify(report, null, 2));
  chrome.kill('SIGKILL');
}
const failed = report.steps.filter((s) => !s.ok);
console.log(`ml-drive: ${report.steps.length - failed.length}/${report.steps.length} steps ok -> ${outdir}/walk-report.json`);
process.exit(failed.length ? 1 : 0);
