#!/usr/bin/env node
// Functional verification of a generated static To-Do web app in a real headless browser.
//
//   node scripts/verify-web-project.js <projectDir> [--expect index.html,style.css,script.js] [--json out.json]
//
// Requires Playwright (optional; not a Jarvis dependency):  npm i -D playwright && npx playwright install chromium
// Selectors are heuristic because generated markup varies; every check is reported individually.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { validateFile } = require('../services/codeValidator');

function parseArgs(argv) {
  const args = { dir: null, expect: ['index.html', 'style.css', 'script.js'], json: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--expect') args.expect = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--json') args.json = argv[++i];
    else if (!args.dir) args.dir = argv[i];
  }
  return args;
}

async function staticChecks(dir, expected) {
  const checks = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  checks.push({ check: `exactly ${expected.length} files: ${expected.join(', ')}`, pass: JSON.stringify(names) === JSON.stringify([...expected].sort()), detail: names.join(', ') });
  checks.push({ check: 'no sub-directories', pass: !entries.some(e => e.isDirectory()) });
  const htmlFile = expected.find(f => f.endsWith('.html')) || 'index.html';
  const htmlPath = path.join(dir, htmlFile);
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    for (const f of expected.filter(f => /\.(css|js)$/.test(f))) {
      const re = f.endsWith('.css') ? new RegExp(`<link[^>]+href=["']\\.?/?${f.replace('.', '\\.')}["']`, 'i') : new RegExp(`<script[^>]+src=["']\\.?/?${f.replace('.', '\\.')}["']`, 'i');
      checks.push({ check: `${htmlFile} references ${f}`, pass: re.test(html) });
    }
  }
  for (const f of expected) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { checks.push({ check: `${f} is valid`, pass: false, detail: 'missing' }); continue; }
    const r = await validateFile({ path: f, content: fs.readFileSync(p, 'utf8'), context: { plannedFiles: expected, environment: 'browser', moduleType: 'script' } });
    checks.push({ check: `${f} passes static validation`, pass: r.valid, detail: r.errors.map(e => `${e.rule}: ${e.message}`).join('; ') || undefined });
  }
  return { checks, htmlPath };
}

async function browserChecks(htmlPath) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    return { skipped: 'Playwright is not installed (npm i -D playwright && npx playwright install chromium)', checks: [] };
  }
  const checks = [];
  const pageErrors = [];
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const url = pathToFileURL(htmlPath).href;
  const record = (check, pass, detail) => checks.push({ check, pass: Boolean(pass), ...(detail ? { detail } : {}) });

  try {
    await page.goto(url);
    await page.waitForLoadState('load');

    const input = page.locator('input[type="text"]:visible, input:not([type]):visible, textarea:visible').first();
    const hasInput = (await input.count()) > 0;
    record('page has a visible text input', hasInput);
    if (!hasInput) throw new Error('no input');

    // Controls are located by starting at the innermost element that contains a task's text and
    // walking up its ancestors until a matching control appears. The walk stops before any
    // container that also holds another task's text, so a control belonging to a different task
    // is never clicked or credited. Task C is a sentinel that is never touched.
    const A = 'Verify task A';
    const B = 'Verify task B';
    const C = 'Verify task C';
    let markCounter = 0;

    async function controlFor(text, kind) {
      const attr = `data-jarvis-verify-${++markCounter}`;
      const others = [A, B, C].filter(t => t !== text);
      const found = await page.evaluate(([t, k, otherTexts, a]) => {
        const DELETE = /delete|remove|trash|×|✕|✖|🗑/i;
        const COMPLETE = /complete|done|toggle|check|✓|✔/i;
        const describe = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ''), el.textContent].join(' ');
        const isMatch = (el) => (k === 'complete'
          ? el.matches('input[type=checkbox]') || (el.matches('button,[role=button]') && COMPLETE.test(describe(el)) && !DELETE.test(describe(el)))
          : el.matches('button,[role=button],a') && (DELETE.test(describe(el)) || /^\s*x\s*$/i.test(el.textContent)));
        const holders = [...document.querySelectorAll('body *')].filter(el => el.textContent.includes(t));
        holders.sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length);
        for (let node = holders[0]; node && node !== document.body; node = node.parentElement) {
          if (otherTexts.some(o => node.textContent.includes(o))) return false;
          const control = [node, ...node.querySelectorAll('*')].find(isMatch);
          if (control) { control.setAttribute(a, '1'); return true; }
        }
        return false;
      }, [text, kind, others, attr]);
      return found ? page.locator(`[${attr}]`).first() : null;
    }

    async function isCompleted(text) {
      const others = [A, B, C].filter(t => t !== text);
      return page.evaluate(([t, otherTexts]) => {
        const holders = [...document.querySelectorAll('body *')].filter(el => el.textContent.includes(t));
        holders.sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length);
        const looksDone = (n) => (n.matches('input[type=checkbox]') && n.checked)
          || /(^|[\s_-])(completed?|done|checked|finished)($|[\s_-])/i.test(String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || ''))
          || getComputedStyle(n).textDecorationLine.includes('line-through')
          || n.getAttribute('aria-checked') === 'true';
        for (let node = holders[0]; node && node !== document.body; node = node.parentElement) {
          if (otherTexts.some(o => node.textContent.includes(o))) return false;
          if ([node, ...node.querySelectorAll('*')].some(looksDone)) return true;
        }
        return false;
      }, [text, others]);
    }

    async function addTask(text) {
      await input.fill(text);
      await input.press('Enter');
      try { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 800 }); return true; } catch (_) { /* try a button */ }
      const addBtn = page.locator('button, input[type="submit"], input[type="button"]').filter({ hasText: /add|create|save|\+/i }).first();
      const addByAttr = page.locator('button[aria-label*="add" i], button[title*="add" i], button[id*="add" i], button[class*="add" i]').first();
      const btn = (await addBtn.count()) ? addBtn : addByAttr;
      if (await btn.count()) {
        await input.fill(text);
        await btn.click();
      }
      try { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 1500 }); return true; } catch (_) { return false; }
    }

    record(`add task "${A}"`, await addTask(A));
    record(`add task "${B}"`, await addTask(B));
    record(`add task "${C}" (sentinel, never touched)`, await addTask(C));
    const body = await page.locator('body').innerText();
    record('all tasks are displayed', [A, B, C].every(t => body.includes(t)));

    const completeControl = await controlFor(A, 'complete');
    record('task A has its own completion control', Boolean(completeControl));
    if (completeControl) await completeControl.click(); // click, not check(): apps often re-render and detach it
    await page.waitForTimeout(250);
    record('task A can be marked completed', await isCompleted(A));
    record('completing A does not complete the sentinel C', !(await isCompleted(C)));

    const deleteControl = await controlFor(B, 'delete');
    record('task B has its own delete control', Boolean(deleteControl));
    if (deleteControl) await deleteControl.click();
    await page.waitForTimeout(300);
    const afterDelete = await page.locator('body').innerText();
    record('task B can be deleted (A and C remain)', !afterDelete.includes(B) && afterDelete.includes(A) && afterDelete.includes(C));

    // Persistence
    const stored = await page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join('\n'));
    record('tasks are written to localStorage', stored.includes(A));
    await page.reload();
    await page.waitForLoadState('load');
    await page.waitForTimeout(250);
    const after = await page.locator('body').innerText();
    record('after reload, tasks A and C are still there', after.includes(A) && after.includes(C));
    record('after reload, deleted task B stays deleted', !after.includes(B));
    record('after reload, task A is still completed', after.includes(A) && await isCompleted(A));
    record('after reload, sentinel C is still not completed', after.includes(C) && !(await isCompleted(C)));
  } catch (e) {
    if (e.message !== 'no input') record('browser run completed', false, e.message);
  } finally {
    record('no JavaScript errors in the console', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || undefined);
    await browser.close();
  }
  return { checks };
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.dir || !fs.existsSync(args.dir)) {
    console.error('Usage: node scripts/verify-web-project.js <projectDir> [--expect a,b,c] [--json out.json]');
    process.exit(2);
  }
  const dir = path.resolve(args.dir);
  const st = await staticChecks(dir, args.expect);
  const br = fs.existsSync(st.htmlPath) ? await browserChecks(st.htmlPath) : { checks: [], skipped: 'no HTML file' };
  const all = [...st.checks, ...br.checks];
  const passed = all.filter(c => c.pass).length;
  for (const c of all) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}${c.detail ? `  (${c.detail})` : ''}`);
  if (br.skipped) console.log(`SKIP  browser checks: ${br.skipped}`);
  console.log(`\n${passed}/${all.length} checks passed${br.skipped ? ' (browser checks skipped)' : ''}`);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ projectDir: dir, passed, total: all.length, browserSkipped: br.skipped || null, checks: all }, null, 2));
  process.exit(passed === all.length && !br.skipped ? 0 : 1);
})();
