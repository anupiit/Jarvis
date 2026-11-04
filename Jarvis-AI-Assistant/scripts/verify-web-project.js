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

    // The task "item" is the smallest element that contains the task text AND a control
    // (checkbox/button). Re-resolved on every use because apps often re-render their list.
    let markCounter = 0;
    async function itemByText(text) {
      const attr = `data-jarvis-verify-${++markCounter}`;
      const found = await page.evaluate(([t, a]) => {
        const withText = [...document.querySelectorAll('body *')].filter(el => el.textContent.includes(t));
        const withControl = withText.filter(el => el.querySelector('input[type=checkbox], button, [role=button]'));
        const pool = withControl.length ? withControl : withText;
        pool.sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length);
        if (!pool.length) return false;
        pool[0].setAttribute(a, '1');
        return true;
      }, [text, attr]);
      return found ? page.locator(`[${attr}]`).first() : null;
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

    record('add task "Verify task A"', await addTask('Verify task A'));
    record('add task "Verify task B"', await addTask('Verify task B'));
    const body = await page.locator('body').innerText();
    record('both tasks are displayed', body.includes('Verify task A') && body.includes('Verify task B'));

    // Complete task A
    const itemA = await itemByText('Verify task A');
    if (itemA) {
      const checkbox = itemA.locator('input[type="checkbox"]').first();
      if (await checkbox.count()) await checkbox.click(); // not check(): many apps re-render and detach the box
      else {
        const completeBtn = itemA.locator('button').filter({ hasText: /complete|done|✓|✔|check/i }).first();
        if (await completeBtn.count()) await completeBtn.click(); else await itemA.getByText('Verify task A').first().click();
      }
    }
    await page.waitForTimeout(200);
    const completedA = async () => { const el = await itemByText('Verify task A'); return el ? el.evaluate((el) => {
      const cb = el.querySelector('input[type="checkbox"]');
      if (cb && cb.checked) return true;
      const all = [el, ...el.querySelectorAll('*')];
      return all.some(n => /complete|done|checked|finished/i.test(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || '')
        || getComputedStyle(n).textDecorationLine.includes('line-through'));
    }) : false; };
    record('task A can be marked completed', await completedA());

    // Delete task B
    const itemB = await itemByText('Verify task B');
    if (itemB) {
      const delAttr = itemB.locator('[aria-label*="delete" i], [aria-label*="remove" i], [title*="delete" i], [class*="delete" i], [class*="remove" i]').first();
      const delText = itemB.locator('button, [role="button"], a').filter({ hasText: /delete|remove|×|✕|✖|🗑|trash|^\s*x\s*$/i }).first();
      const delTarget = (await delAttr.count()) ? delAttr : delText;
      if (await delTarget.count()) await delTarget.click();
    }
    await page.waitForTimeout(300);
    record('task B can be deleted', !(await page.locator('body').innerText()).includes('Verify task B'));

    // Persistence
    const stored = await page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join('\n'));
    record('tasks are written to localStorage', stored.includes('Verify task A'));
    await page.reload();
    await page.waitForLoadState('load');
    await page.waitForTimeout(200);
    const after = await page.locator('body').innerText();
    record('after reload, task A is still there', after.includes('Verify task A'));
    record('after reload, deleted task B stays deleted', !after.includes('Verify task B'));
    record('after reload, task A is still completed', after.includes('Verify task A') && await completedA());
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
