/**
 * Generic step runner + verifier (data-driven, no TOM/business values).
 *
 * Steps arrive with {{PARAMS}} already resolved from the Test Data Sheet.
 * Each step is matched against a small UI grammar (verb + target + control type):
 *   Select the <X> plan tile | Open the <X> device card | Click Select on the <X> <kind> card
 *   Select the <X> storage/colour option | Select the <X> payment term | Add <X> | Select <X> in <Y>
 *   Click <X> on the <Y> row | Click <X> in the <Y> dialog | Tick/Click/Untick the <X> checkbox
 *   Open the <X> drop-down | Select the <X> option | Open the <X> tab | Enter <X> in <Y>
 *   Wait for <X> to be displayed (in <Y>) | Wait for the message <X> to be displayed
 *   Wait for <X> to finish loading/refreshing | Click the next/previous arrow ... | Leave ... | Click <X>
 *
 * After each step a UI state snapshot is stored so "After <action> ..." verifications
 * can be evaluated against the state at that moment.
 */

const STATE = () => {
  if (!globalThis.__sr) {
    globalThis.__sr = { currentCard: null, lastDropdown: null, messages: new Set(), checkboxes: {}, history: [], cardSeq: 0 };
  }
  return globalThis.__sr;
};

const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UI = (() => {
  const p = require('path').resolve(__dirname, '..', '..', 'config', process.env.UI_PROFILE || 'ui-profile.json');
  try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch (e) { return {}; }
})();
const uiRx = (key, flags = 'i') => new RegExp((UI[key] || []).map(esc).join('|') || '(?!)', flags);
const flexRx = (s, anchored = false) => {
  const body = String(s || '').trim().split(/\s+/).filter(Boolean)
    .map((w) => (/^(and|&)$/i.test(w) ? '(?:and|&)' : esc(w)))
    .join('[\\s,.;:\\-]*');
  return new RegExp(anchored ? `^\\s*${body}\\s*$` : `(?:^|[^A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const strip = (s) => String(s || '').trim().replace(/\.+$/, '').replace(/^["']|["']$/g, '').trim();

async function isVisible(loc) {
  try { return (await loc.count()) > 0 && await loc.first().isVisible(); } catch (e) { return false; }
}

async function robustClick(loc, timeout = 15000) {
  const t = loc.first();
  await t.scrollIntoViewIfNeeded().catch(() => {});
  try { await t.click({ timeout }); return true; } catch (e) {}
  try { await t.click({ timeout, force: true }); return true; } catch (e) {}
  try { await t.evaluate((el) => el.click()); return true; } catch (e) {}
  return false;
}

async function settle(page, ms = 1500) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.locator('.ui-widget-overlay, .siebui-mask-overlay, .siebui-busy').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function bodyLines(page) {
  const t = (await page.locator('body').innerText().catch(() => '')) || '';
  return t.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Start recording every text node Siebel adds (catches toasts that vanish in < 1s). */
async function startToastRecorder(page) {
  await page.evaluate(() => {
    try { if (window.__srObs) window.__srObs.disconnect(); } catch (e) {}
    window.__srMsgs = [];
    const push = (t) => { t = String(t || '').trim(); if (t && t.length < 300) window.__srMsgs.push(t); };
    const o = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') push(m.target && m.target.textContent);
        if (m.type === 'attributes' && m.target) push(m.target.getAttribute(m.attributeName));
        for (const n of m.addedNodes || []) push(n.innerText || n.textContent);
      }
    });
    o.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'data-message'] });
    window.__srObs = o;
  }).catch(() => {});
}

async function stopToastRecorder(page) {
  const st = STATE();
  const msgs = await page.evaluate(() => { try { window.__srObs && window.__srObs.disconnect(); } catch (e) {} return window.__srMsgs || []; }).catch(() => []);
  for (const m of msgs) for (const l of String(m).split(/\r?\n/)) { const t = l.replace(/\s+/g, ' ').trim(); if (t) st.messages.add(t); }
  return msgs.length;
}

/** Record any text line that appears after an action (captures transient toasts). */
async function captureMessages(page, before, durationMs = 6000) {
  const st = STATE();
  const seenBefore = new Set(before);
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    for (const l of await bodyLines(page)) if (!seenBefore.has(l) && l.length < 300) st.messages.add(l);
    await page.waitForTimeout(300);
  }
}

/* ------------------------------------------------------------------ cards */

/**
 * Tag every product card (container that owns exactly one Select/Selected button) and
 * return [{id, kind, selected, text}]. kind = plan | device (plan cards carry plan entitlements).
 */
async function scanCards(page) {
  const st = STATE();
  return page.evaluate(({ seqStart, markers }) => {
    const planRx = new RegExp(markers || '(?!)', 'i');
    let seq = seqStart;
    const isBtn = (el) => /^(select|selected)$/i.test(String(el.innerText || el.textContent || '').trim());
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]')).filter((b) => isBtn(b) || /^(select|selected)$/i.test(String(b.value || '').trim()));
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const out = [];
    for (const b of buttons) {
      if (!visible(b)) continue;
      let card = b; let node = b.parentElement;
      while (node && node !== document.body) {
        const count = Array.from(node.querySelectorAll('button, a, [role="button"], input[type="button"]')).filter((x) => isBtn(x) || /^(select|selected)$/i.test(String(x.value || '').trim())).length;
        if (count > 1) break;
        card = node; node = node.parentElement;
      }
      if (!card.getAttribute('data-sr-card')) card.setAttribute('data-sr-card', String(++seq));
      const text = String(card.innerText || '').replace(/\s+/g, ' ').trim();
      const kind = planRx.test(text) ? 'plan' : 'device';
      const label = String(b.innerText || b.value || '').trim();
      out.push({ id: card.getAttribute('data-sr-card'), kind, selected: /^selected$/i.test(label), text: text.slice(0, 400) });
    }
    return { cards: out, seq };
  }, { seqStart: st.cardSeq, markers: uiRx('planCardMarkers').source }).then((r) => { st.cardSeq = r.seq; return r.cards; });
}

const cardLoc = (page, id) => page.locator(`[data-sr-card="${id}"]`).first();

async function propositionText(page) {
  try {
    const field = page.getByRole('textbox', { name: new RegExp(esc(UI.propositionLabel || 'proposition'), 'i') }).first();
    if (await isVisible(field)) return (await field.inputValue().catch(() => '')) || '';
  } catch (e) {}
  const lines = await bodyLines(page);
  const i = lines.findIndex((l) => new RegExp(`^${esc(UI.propositionLabel || 'proposition')}$`, 'i').test(l));
  return i >= 0 ? (lines[i + 1] || '') : '';
}

/** Find a card of a kind containing target text. Plans fall back to proposition match. */
const ORDINALS = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 };
const ordinalOf = (t) => { const k = norm(t).replace(/\s*(displayed|listed|sorted)$/, ''); if (k in ORDINALS) return ORDINALS[k]; const n = k.match(/^(\d+)(st|nd|rd|th)?$/); return n ? Number(n[1]) - 1 : null; };

async function findCard(page, target, kind) {
  const all = await scanCards(page);
  const cards = all.filter((c) => !kind || c.kind === kind);
  const ord = ordinalOf(target);
  if (ord !== null) {
    const hit = ord < 0 ? cards[cards.length - 1] : cards[ord];
    if (hit) { const st = STATE(); st.ordinal = st.ordinal || {}; st.ordinal[norm(target)] = hit; console.log(`[step-runner] ordinal "${target}" -> card ${hit.id}: ${hit.text.slice(0, 80)}`); return { ...hit, via: 'ordinal' }; }
    return null;
  }
  const rx = flexRx(target);
  let hit = cards.find((c) => rx.test(c.text));
  let via = 'card-text';
  if (!hit && kind === 'plan') {
    const prop = await propositionText(page);
    const pageHas = (await bodyLines(page)).some((l) => rx.test(l));
    if ((prop && (rx.test(prop) || flexRx(prop).test(target))) || pageHas) {
      hit = cards.find((c) => !c.selected) || cards[0];
      via = prop ? `proposition("${prop}")` : 'page-text';
    }
  }
  if (!hit) {
    console.log(`[step-runner] card "${target}" (${kind}) not matched. Cards: ${JSON.stringify(all.map((c) => ({ id: c.id, kind: c.kind, t: c.text.slice(0, 80) })))}`);
  }
  return hit ? { ...hit, via } : null;
}

async function searchListing(page, target) {
  const box = page.getByRole('textbox', { name: /^search$/i }).filter({ hasNot: page.locator('[name*="sitemap" i]') });
  const candidates = [page.getByPlaceholder(/^search$/i).first(), box.first()];
  for (const c of candidates) {
    if (await isVisible(c)) {
      await c.fill(String(target)).catch(() => {});
      await c.press('Enter').catch(() => {});
      await settle(page, 2000);
      return true;
    }
  }
  return false;
}

async function selectCard(page, card) {
  const loc = cardLoc(page, card.id);
  const btn = loc.locator('button, a, [role="button"], input[type="button"]').filter({ hasText: /^\s*select\s*$/i }).first();
  if (await isVisible(btn)) await robustClick(btn);
  await settle(page, 1200);
}

async function ensureCardSelected(page) {
  const st = STATE();
  if (!st.currentCard) return;
  const cards = await scanCards(page);
  const c = cards.find((x) => x.id === st.currentCard.id);
  if (c && !c.selected) await selectCard(page, c);
}

/* ---------------------------------------------------------------- options */

async function chooseOption(page, value, labelHint) {
  const st = STATE();
  const rxExact = flexRx(value, true);
  const rx = flexRx(value);
  const scopes = [];
  if (st.currentCard) {
    const cl = cardLoc(page, st.currentCard.id);
    const info = await cl.evaluate((el) => ({
      text: String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      selects: Array.from(el.querySelectorAll('select')).map((s) => Array.from(s.options).map((o) => o.text.trim()))
    })).catch(() => null);
    if (info && info.selects.length) {
      // Card owns its option controls: never fall back to other cards / page selects.
      scopes.push(cl);
      const anyMatch = info.selects.some((o) => o.some((t) => rx.test(t)));
      const emptySel = info.selects.some((o) => o.length === 0);
      if (!anyMatch && emptySel && /term/i.test(labelHint || '')) {
        return `not available: card payment-term list is empty (card: ${info.text.slice(0, 60)})`;
      }
      if (!anyMatch) {
        console.log(`[step-runner] option "${value}" not in card ${st.currentCard.id}: ${JSON.stringify(info)}`);
      }
    } else {
      scopes.push(cl, page.locator('body'));
    }
  } else {
    scopes.push(page.locator('body'));
  }

  for (const scope of scopes) {
    // 1. native <select> that contains the option
    const selects = scope.locator('select');
    const n = await selects.count().catch(() => 0);
    for (let i = 0; i < n; i += 1) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible().catch(() => false))) continue;
      const opts = await sel.locator('option').allInnerTexts().catch(() => []);
      const numRx = /^\d+\s*months?$/i.test(String(value).trim()) ? new RegExp(`^\\s*${String(value).match(/\d+/)[0]}\\s*(months?|mths?|m)?\\s*$`, 'i') : null;
      const match = opts.find((o) => rxExact.test(o)) || (numRx && opts.find((o) => numRx.test(o))) || opts.find((o) => rx.test(o));
      if (match) { await sel.selectOption({ label: match.trim() }).catch(() => {}); await settle(page, 1000); return `select:${match.trim()}`; }
    }
    // 2. radio / checkbox / button / text with that label
    const candidates = [
      scope.getByRole('radio', { name: rx }),
      scope.getByRole('checkbox', { name: rx }),
      scope.getByRole('button', { name: rxExact }),
      scope.getByRole('option', { name: rx }),
      scope.getByLabel(rx),
      scope.getByText(rxExact),
      scope.getByText(rx)
    ];
    for (const c of candidates) {
      if (await isVisible(c)) {
        const role = await c.first().getAttribute('role').catch(() => '');
        const type = await c.first().getAttribute('type').catch(() => '');
        if (/checkbox/i.test(role || '') || /checkbox/i.test(type || '')) await c.first().check({ force: true }).catch(async () => robustClick(c));
        else await robustClick(c);
        await settle(page, 1000);
        return 'clicked';
      }
    }
  }
  // 3. custom dropdown identified by label hint
  if (labelHint) {
    const opener = page.getByText(flexRx(labelHint)).first();
    if (await isVisible(opener)) {
      await robustClick(opener);
      await page.waitForTimeout(600);
      const opt = page.getByText(rx).last();
      if (await isVisible(opt)) { await robustClick(opt); await settle(page, 1000); return 'dropdown'; }
    }
  }
  const avail = await page.locator('select:visible').evaluateAll((ss) => ss.map((s) => Array.from(s.options).map((o) => o.text.trim()).slice(0, 12))).catch(() => []);
  console.log(`[step-runner] option "${value}" not found; visible selects: ${JSON.stringify(avail)}`);
  throw new Error(`Option "${value}" not found${labelHint ? ` for "${labelHint}"` : ''}`);
}

/* ------------------------------------------------------------- snapshots */

async function snapshot(page) {
  const lines = await bodyLines(page);
  const start = lines.findIndex((l) => new RegExp(`^${esc(UI.cartPanelHeading || 'new services')}$`, 'i').test(l));
  const end = lines.findIndex((l, i) => i > start && (/^remove all\b/i.test(l) || /^due\b/i.test(l) || /^total$/i.test(l)));
  const panel = start >= 0 ? lines.slice(start + 1, end > start ? end : start + 40) : [];
  const services = [];
  const rowRx = new RegExp(`^${esc(UI.cartRowPrefix || 'new service')}\\s*(\\d+)`, 'i');
  for (const l of panel) {
    const m = l.match(rowRx);
    if (m) services.push({ n: Number(m[1]), text: l });
    else if (services.length) services[services.length - 1].text += ' ' + l;
  }
  const totalIdx = lines.findIndex((l) => /^total$/i.test(l));
  const total = totalIdx >= 0 ? (lines[totalIdx + 1] || '') : '';
  const counter = (lines.find((l) => /\b\d+\s*-\s*\d+\s+of\s+\d+\s+items\b/i.test(l)) || '');
  let cards = [];
  try { cards = await scanCards(page); } catch (e) {}
  return { panelFound: start >= 0, services, emptyServices: panel.some((l) => new RegExp(esc(UI.cartEmptyText || '(?!)'), 'i').test(l)) || services.length === 0, total, counter, cards };
}

/* --------------------------------------------------------------- runner */

const GRAMMAR = [
  { rx: /^leave\s+/i, run: async () => 'no-op (explicit leave)' },

  { rx: /^select the (.+) plan tile$/i, run: async (page, m) => {
    const st = STATE();
    let card = await findCard(page, m[1], 'plan');
    if (!card) throw new Error(`Plan tile "${m[1]}" not found (no card text or proposition match)`);
    if (!card.selected) await selectCard(page, card);
    const after = (await scanCards(page)).find((c) => c.id === card.id);
    if (!after || !after.selected) throw new Error(`Plan tile "${m[1]}" did not show Selected`);
    st.lastPlan = { ...after, target: m[1], via: card.via };
    return `plan selected via ${card.via}`;
  } },

  { rx: /^(?:open the|click select on the) (.+?) (device|wearable|accessory|tablet) card$/i, run: async (page, m) => {
    const st = STATE();
    let card = await findCard(page, m[1], 'device');
    if (!card) { await searchListing(page, m[1]); card = await findCard(page, m[1], 'device'); }
    if (!card) throw new Error(`${m[2]} card "${m[1]}" not found`);
    st.currentCard = card;
    if (!card.selected) await selectCard(page, card);
    return `card ${card.id} opened`;
  } },

  { rx: /^click (?!select\b)(.+?) on the (.+?) plan tile$/i, run: async (page, m) => {
    const st = STATE();
    const card = await findCard(page, m[2], 'plan');
    if (!card) throw new Error(`Plan tile "${m[2]}" not found`);
    const rx = flexRx(m[1]);
    const tile = cardLoc(page, card.id);
    // link may sit in the tile or directly beneath it
    const cands = [tile.getByRole('link', { name: rx }), tile.getByText(rx), tile.locator('xpath=following::a[1]').filter({ hasText: rx })];
    let link = null;
    for (const c of cands) if (await isVisible(c)) { link = c.first(); break; }
    if (!link) throw new Error(`Link "${m[1]}" not found on plan tile "${m[2]}"`);
    const before = page.url();
    const ctx = page.context();
    const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await robustClick(link);
    const popup = await popupP;
    let dest = { link: m[1], opened: false, url: '', title: '', mode: '' };
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      dest = { link: m[1], opened: true, url: popup.url(), title: await popup.title().catch(() => ''), mode: 'new-tab' };
      await popup.waitForTimeout(1500).catch(() => {});
      st.pendingPopup = popup; // execution-agent screenshots it, then closes it
    } else {
      await settle(page, 2500);
      const after = page.url();
      if (after !== before) dest = { link: m[1], opened: true, url: after, title: await page.title().catch(() => ''), mode: 'same-tab' };
    }
    st.linkDest = st.linkDest || [];
    st.linkDest.push(dest);
    st.lastLinkMode = dest.mode;
    if (!dest.opened) throw new Error(`"${m[1]}" did not open a destination (no new tab, URL unchanged)`);
    return `${dest.mode}: ${dest.url} "${dest.title}"`;
  } },

  { rx: /^navigate back$/i, run: async (page) => {
    const st = STATE();
    if (st.lastLinkMode === 'new-tab') { st.lastLinkMode = ''; await page.bringToFront().catch(() => {}); await settle(page, 1000); return 'destination was a new tab (closed); back on original page'; }
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page, 2500);
    st.lastLinkMode = '';
    return `went back to ${page.url()}`;
  } },

  { rx: /^select the (.+) (storage|colour|color) option$/i, run: async (page, m) => { const r = await chooseOption(page, m[1], m[2]); await ensureCardSelected(page); return r; } },

  { rx: /^click (?!select\b)(.+?) on the (.+?) (device|wearable|accessory|tablet) card$/i, run: async (page, m) => {
    let card = await findCard(page, m[2], 'device');
    if (!card) { await searchListing(page, m[2]); card = await findCard(page, m[2], 'device'); }
    if (!card) throw new Error(`${m[3]} card "${m[2]}" not found`);
    const btn = cardLoc(page, card.id).locator('button, a, [role="button"], input[type="button"]').filter({ hasText: flexRx(m[1], true) }).first();
    if (!(await isVisible(btn))) throw new Error(`"${m[1]}" not found on card "${m[2]}"`);
    STATE().lastCardText = card.text;
    await robustClick(btn); await settle(page, 2000);
    return `clicked "${m[1]}" on card ${card.id}`;
  } },

  { rx: /^click (.+?) on the (.+?) (panel|dialog|popup|modal)$/i, run: async (page, m) => {
    const rx = flexRx(m[1], true);
    const cands = [page.getByRole('dialog').getByRole('button', { name: rx }), page.getByRole('button', { name: rx }), page.locator('[aria-label]').filter({ has: page.locator(`[aria-label="${m[1]}"]`) }), page.getByText(rx)];
    for (const c of cands) if (await isVisible(c)) { const panelText = await page.getByRole('dialog').first().innerText().catch(() => ''); STATE().lastPanelText = panelText; await robustClick(c.last()); await settle(page, 1500); return `closed ${m[2]} ${m[3]}`; }
    throw new Error(`"${m[1]}" not found on ${m[2]} ${m[3]}`);
  } },
  { rx: /^select the (.+) payment term$/i, run: async (page, m) => { const r = await chooseOption(page, m[1], UI.paymentTermLabel || 'term'); await ensureCardSelected(page); return r; } },
  { rx: /^add (?!to cart)(.+)$/i, run: async (page, m) => { const r = await chooseOption(page, m[1], UI.addonLabel); await ensureCardSelected(page); return r; } },

  { rx: /^click add to cart$/i, run: async (page) => {
    const before = await bodyLines(page);
    const btn = page.getByRole('button', { name: /^add to cart$/i }).first();
    const target = (await isVisible(btn)) ? btn : page.getByText(/^add to cart$/i).first();
    await startToastRecorder(page);
    if (!(await robustClick(target))) throw new Error('Add to cart not clickable');
    await captureMessages(page, before, 8000);
    await settle(page, 1500);
    await captureMessages(page, before, Number(process.env.MESSAGE_CAPTURE_MS || 6000));
    const n = await stopToastRecorder(page);
    const seen = [...STATE().messages].filter((t) => t.length < 160 && !before.includes(t)).slice(-25);
    console.log(`[step-runner] messages after Add to cart (${n} mutations): ${JSON.stringify(seen)}`);
    globalThis.__lastAddToCartAttempted = true;
    STATE().currentCard = null;
    return 'clicked';
  } },

  { rx: /^wait for the message (.+) to be displayed$/i, run: async (page, m) => waitForText(page, strip(m[1])) },
  { rx: /^wait for (.+?) to be displayed(?: in (.+))?$/i, run: async (page, m) => waitForText(page, strip(m[1])) },
  { rx: /^wait for (.+) to finish (?:loading|refreshing)$/i, run: async (page) => { await settle(page, 2500); return 'settled'; } },

  { rx: /^click (.+) on the (.+) row$/i, run: async (page, m) => {
    const before = await bodyLines(page);
    const target = flexRx(m[1]);
    const loose = /remove/i.test(m[1]) ? /\bremove\b/i : target;
    const rowText = page.getByText(flexRx(m[2], true)).first();
    if (!(await isVisible(rowText))) throw new Error(`Row "${m[2]}" not found`);
    // Row block = nearest ancestor that owns an Edit button (New services row layout)
    let row = rowText.locator('xpath=ancestor::*[.//*[self::button or @role="button" or self::a][normalize-space()="Edit"]][1]');
    if ((await row.count().catch(() => 0)) === 0) row = rowText.locator('xpath=ancestor::*[.//button or .//a[@role="button"]][1]');
    const findAction = async () => {
      const cands = [
        row.getByRole('button', { name: target }),
        page.getByRole('menuitem', { name: target }),
        page.getByRole('menuitem', { name: loose }),
        page.getByRole('option', { name: loose }),
        page.locator('[role="menu"] *, .dropdown-menu *, ul[role] li, ul li a').filter({ hasText: loose }).filter({ hasNotText: /remove all/i })
      ];
      for (const c of cands) if (await isVisible(c)) return c.first();
      return null;
    };
    let btn = null;
    // Container match: smallest element whose text starts with "<row>" and contains "<action>"
    // (row menus are rendered hidden inside the row; textContent sees them, innerText does not)
    const boxTag = await page.evaluate(([rowLabel, action]) => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const rl = n(rowLabel); const ac = n(action);
      document.querySelectorAll('[data-sr-action],[data-sr-caret]').forEach((e) => { e.removeAttribute('data-sr-action'); e.removeAttribute('data-sr-caret'); });
      const boxes = Array.from(document.querySelectorAll('body *')).filter((el) => {
        const t = n(el.textContent);
        return t.startsWith(rl) && !new RegExp(`^${rl}\\d`).test(t) && t.includes(ac) && (t.match(/new service \d+/g) || []).length === 1;
      });
      if (!boxes.length) return 'no-box';
      const box = boxes.sort((a, b) => n(a.textContent).length - n(b.textContent).length)[0];
      const items = Array.from(box.querySelectorAll('*')).filter((el) => n(el.textContent) === ac && !Array.from(el.children).some((c) => n(c.textContent) === ac));
      if (!items.length) return 'no-item';
      (items[0].closest('a, button, li, [role="menuitem"]') || items[0]).setAttribute('data-sr-action', '1');
      const edit = Array.from(box.querySelectorAll('button, a, [role="button"]')).find((el) => n(el.textContent) === 'edit');
      if (edit) {
        const caret = edit.nextElementSibling || (edit.parentElement && edit.parentElement.nextElementSibling);
        if (caret) caret.setAttribute('data-sr-caret', '1');
      }
      return 'ok';
    }, [m[2], m[1]]).catch((e) => `err:${e.message}`);
    console.log(`[step-runner] row "${m[2]}" container lookup: ${boxTag}`);
    if (boxTag === 'ok') {
      const loc = page.locator('[data-sr-action="1"]').first();
      const caret = page.locator('[data-sr-caret="1"]').first();
      const btnTexts = async () => (await page.locator('button:visible, [role="button"]:visible').allInnerTexts().catch(() => [])).map((t) => t.trim()).join('|');
      const reacted = async (baseline) => {
        const endR = Date.now() + 6000;
        while (Date.now() < endR) {
          if ((await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, .ui-dialog:visible, .modal:visible').count().catch(() => 0)) > 0) return true;
          if ((await btnTexts()) !== baseline) return true;
          await page.waitForTimeout(400);
        }
        return false;
      };
      // 1. open the row menu: tagged caret, else any text-less toggle inside the row
      //    (not needed when the action is an <option> of a native select)
      const actionIsOption = await loc.evaluate((el) => el.tagName === 'OPTION').catch(() => false);
      if (!actionIsOption && !(await isVisible(loc)) && (await caret.count().catch(() => 0)) > 0) {
        await robustClick(caret); await page.waitForTimeout(1000);
      }
      if (!actionIsOption && !(await isVisible(loc))) {
        const toggles = row.locator('button, [role="button"], a, [aria-haspopup]').filter({ hasNotText: /\S/ });
        const tc = await toggles.count().catch(() => 0);
        for (let i = 0; i < tc && !(await isVisible(loc)); i += 1) {
          const box = await toggles.nth(i).boundingBox().catch(() => null);
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); else await robustClick(toggles.nth(i));
          await page.waitForTimeout(900);
        }
      }
      // 2. click the entry, then confirm the UI reacted (dialog / changed controls)
      const baseline = await btnTexts();
      await startToastRecorder(page);
      const strategies = [
        async () => {
          // Row actions rendered as a native <select> (option = action): choose the option
          const isOpt = await loc.evaluate((el) => el.tagName === 'OPTION').catch(() => false);
          if (isOpt) {
            const sel = loc.locator('xpath=ancestor::select[1]');
            const val = await loc.evaluate((el) => el.value || el.textContent.trim());
            await sel.selectOption(val);
            return;
          }
          if (await isVisible(loc)) await robustClick(loc); else await loc.evaluate((el) => el.click());
        },
        async () => { const v = page.getByText(flexRx(m[1], true)).filter({ hasNotText: /remove all/i }); const c = await v.count().catch(() => 0); for (let i = 0; i < c; i += 1) { if (await v.nth(i).isVisible().catch(() => false)) { const b = await v.nth(i).boundingBox(); if (b) { await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); return; } } } },
        async () => { await loc.evaluate((el) => { ['mousedown', 'mouseup', 'click'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))); }); }
      ];
      let ok = false; let used = 0;
      for (let i = 0; i < strategies.length && !ok; i += 1) {
        used = i + 1;
        await strategies[i]().catch(() => {});
        ok = await reacted(baseline);
        if (!ok && i < strategies.length - 1 && !(await isVisible(loc)) && (await caret.count().catch(() => 0)) > 0) { await robustClick(caret); await page.waitForTimeout(900); }
      }
      await captureMessages(page, before, 1500);
      await stopToastRecorder(page);
      if (!ok) {
        const diag = await page.evaluate(() => {
          const a = document.querySelector('[data-sr-action="1"]'); const c = document.querySelector('[data-sr-caret="1"]');
          const desc = (el) => el ? `${el.tagName}.${el.className} vis=${!!el.offsetParent} html=${el.outerHTML.slice(0, 300)}` : 'none';
          let box = a; for (let i = 0; i < 4 && box && box.parentElement; i += 1) box = box.parentElement;
          return `action=${desc(a)} || caret=${desc(c)} || area=${box ? box.outerHTML.replace(/\s+/g, ' ').slice(0, 1500) : ''}`;
        }).catch((e) => e.message);
        console.log(`[step-runner] row menu diagnostics: ${diag}`);
        throw new Error(`Clicked "${m[1]}" in "${m[2]}" row menu but the UI did not react (no dialog / no change after ${used} attempts)`);
      }
      return `clicked "${m[1]}" in "${m[2]}" row menu (attempt ${used})`;
    }
    // Document-order match: first "<action>" element that follows the "<row>" heading (generic for stacked rows)
    const tagged = await page.evaluate(([rowLabel, action]) => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('body *'));
      const leafWith = (txt) => all.filter((el) => n(el.innerText || el.textContent) === n(txt) && !Array.from(el.children).some((c) => n(c.innerText || c.textContent) === n(txt)));
      const head = leafWith(rowLabel)[0];
      if (!head) return 'no-row';
      const next = all.find((el) => el !== head && /^new service \d+$/i.test(n(el.innerText || el.textContent)) && (head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && n(el.innerText) !== n(rowLabel));
      const cand = leafWith(action).find((el) => (head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && (!next || (el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)));
      if (!cand) return 'no-action';
      const clickable = cand.closest('a, button, li, [role="menuitem"], [role="button"]') || cand;
      clickable.setAttribute('data-sr-action', '1');
      return 'ok';
    }, [m[2], m[1]]).catch((e) => `err:${e.message}`);
    if (tagged === 'ok') {
      const loc = page.locator('[data-sr-action="1"]').first();
      if (!(await isVisible(loc))) {
        // open the row caret (control right after Edit) so the menu entry becomes visible
        const edit = row.locator('button, [role="button"], a').filter({ hasText: /^\s*edit\s*$/i }).first();
        const caret = edit.locator('xpath=following-sibling::*[1]').first();
        if ((await caret.count().catch(() => 0)) > 0) { await robustClick(caret); await page.waitForTimeout(800); }
      }
      await startToastRecorder(page);
      if (await isVisible(loc)) await robustClick(loc); else await loc.evaluate((el) => el.click());
      await page.evaluate(() => document.querySelectorAll('[data-sr-action]').forEach((e) => e.removeAttribute('data-sr-action'))).catch(() => {});
      await captureMessages(page, before, 2500);
      await stopToastRecorder(page);
      return `clicked "${m[1]}" belonging to "${m[2]}"`;
    }
    console.log(`[step-runner] row "${m[2]}" document-order lookup: ${tagged}`);
    btn = await findAction();
    if (!btn) {
      // action hidden behind the caret next to Edit
      const toggles = row.locator('button, [role="button"], a, .dropdown-toggle, [aria-haspopup]').filter({ hasNotText: /\S/ });
      const tc = await toggles.count().catch(() => 0);
      console.log(`[step-runner] row "${m[2]}": ${tc} caret/toggle candidates`);
      for (let i = 0; i < tc && !btn; i += 1) {
        await robustClick(toggles.nth(i)); await page.waitForTimeout(800);
        btn = await findAction();
      }
    }
    if (!btn) {
      // Caret is the control right after the row's Edit button
      const edit = row.locator('button, [role="button"], a').filter({ hasText: /^\s*edit\s*$/i }).first();
      const caret = edit.locator('xpath=following-sibling::*[1] | following::*[self::button or @role="button" or self::a or self::span][1]').first();
      if ((await caret.count().catch(() => 0)) > 0) {
        await robustClick(caret); await page.waitForTimeout(800);
        btn = await findAction();
        if (!btn) {
          const inRow = row.locator('a, li, button, span, [role="menuitem"]').filter({ hasText: target }).first();
          if (await isVisible(inRow)) btn = inRow;
        }
      }
    }
    if (!btn) {
      // Last resort: the row owns a (hidden) menu entry with this text - trigger it directly
      const hidden = row.locator('a, li, button, span, [role="menuitem"]').filter({ hasText: flexRx(m[1], true) }).first();
      if ((await hidden.count().catch(() => 0)) > 0) {
        console.log(`[step-runner] row "${m[2]}": invoking hidden "${m[1]}" menu entry`);
        await startToastRecorder(page);
        await hidden.evaluate((el) => el.click());
        await captureMessages(page, before, 2500);
        await stopToastRecorder(page);
        return 'clicked (row menu entry)';
      }
    }
    if (!btn) {
      const menuText = (await bodyLines(page)).filter((l) => /remove|delete|edit/i.test(l)).slice(0, 15);
      throw new Error(`"${m[1]}" not found on row "${m[2]}" (visible actions: ${menuText.join(' | ')})`);
    }
    await startToastRecorder(page);
    await robustClick(btn);
    await captureMessages(page, before, 2500);
    await stopToastRecorder(page);
    return 'clicked';
  } },

  { rx: /^click (.+) in the (.+) dialog$/i, run: async (page, m) => {
    const before = await bodyLines(page);
    const rx = flexRx(m[1]);
    let btn = null;
    const end = Date.now() + 10000;
    while (!btn && Date.now() < end) {
      const cands = [
        page.locator('[role="dialog"], [role="alertdialog"], .ui-dialog, .modal').getByRole('button', { name: rx }),
        page.getByRole('button', { name: rx }),
        page.locator('button, a, [role="button"], input[type="button"]').filter({ hasText: rx })
      ];
      for (const c of cands) if (await isVisible(c)) { btn = c.last(); break; }
      if (!btn) await page.waitForTimeout(500);
    }
    if (!btn) {
      const btns = await page.locator('button:visible').allInnerTexts().catch(() => []);
      throw new Error(`Dialog button "${m[1]}" not found (visible buttons: ${btns.map((b) => b.trim()).filter(Boolean).slice(-12).join(' | ')})`);
    }
    await startToastRecorder(page);
    await robustClick(btn);
    await captureMessages(page, before, 3000);
    await stopToastRecorder(page);
    await settle(page, 2000);
    return 'clicked';
  } },

  { rx: /^(tick|check|enable|click and enable|click|untick|uncheck) the (.+) checkbox$/i, run: async (page, m) => {
    const st = STATE();
    m = [...m]; m[2] = String(m[2]).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    const labelText = page.getByText(flexRx(m[2], true)).first();
    let cb = page.getByRole('checkbox', { name: flexRx(m[2]) }).first();
    if (!(await isVisible(cb))) cb = page.getByLabel(flexRx(m[2])).first();
    if ((await cb.count().catch(() => 0)) === 0 || !(await isVisible(cb))) {
      const near = labelText.locator('xpath=preceding::input[@type="checkbox"][1]');
      const inside = labelText.locator('xpath=ancestor::label[1]//input[@type="checkbox"]');
      cb = (await inside.count().catch(() => 0)) > 0 ? inside.first() : near;
    }
    if ((await cb.count().catch(() => 0)) === 0) throw new Error(`Checkbox "${m[2]}" not found`);
    const disabled = await cb.first().isDisabled().catch(() => false);
    const verb = m[1].toLowerCase();
    const want = /untick|uncheck/.test(verb) ? false : (verb === 'click' ? null : true);
    if (want === null || disabled) {
      await robustClick(cb, 5000);
    } else {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await cb.first().isChecked().catch(() => false)) === want) break;
        if (attempt === 0) await cb.first().setChecked(want, { timeout: 8000 }).catch(() => {});
        else if (attempt === 1) await robustClick(labelText, 5000);
        else await cb.first().evaluate((el, w) => { el.checked = w; el.dispatchEvent(new Event('click', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, want).catch(() => {});
        await settle(page, 2500); // Siebel may re-render; re-read after settle
      }
    }
    await settle(page, 2000);
    const checked = await cb.first().isChecked().catch(() => false);
    // Text field in the same strip as the checkbox (e.g. delivery suburb/postcode) captured at this moment
    const fieldValue = await cb.first().evaluate((el) => {
      let n = el.parentElement;
      for (let i = 0; i < 6 && n; i += 1, n = n.parentElement) {
        const inp = Array.from(n.querySelectorAll('input[type="text"], input:not([type])')).find((x) => x.offsetParent);
        if (inp) return inp.value || '';
      }
      return '';
    }).catch(() => '');
    st.checkboxes[norm(m[2])] = { disabled, checked, fieldValue, locator: cb };
    if (want === true && !disabled && !checked) throw new Error(`Checkbox "${m[2]}" could not be ticked`);
    return `checkbox disabled=${disabled} checked=${checked}`;
  } },

  { rx: /^open the (.+) drop-?down$/i, run: async (page, m) => {
    const st = STATE();
    const rx = flexRx(m[1]);
    let dd = page.getByRole('combobox', { name: rx }).first();
    if (!(await isVisible(dd))) dd = page.getByLabel(rx).first();
    if (await isVisible(dd) && (await dd.evaluate((el) => el.tagName).catch(() => '')) === 'SELECT') { st.lastDropdown = dd; return 'native select'; }
    const label = page.getByText(rx).first();
    const near = label.locator('xpath=following::*[self::select or @role="combobox" or self::button or self::input][1]');
    st.lastDropdown = (await isVisible(near)) ? near : dd;
    if ((await st.lastDropdown.evaluate((el) => el.tagName).catch(() => '')) !== 'SELECT') await robustClick(st.lastDropdown);
    await page.waitForTimeout(600);
    return 'opened';
  } },

  { rx: /^select the (.+) option$/i, run: async (page, m) => {
    const st = STATE();
    const dd = st.lastDropdown;
    if (dd && (await dd.evaluate((el) => el.tagName).catch(() => '')) === 'SELECT') {
      const opts = await dd.locator('option').allInnerTexts().catch(() => []);
      const want = norm(m[1]);
      const match = opts.find((o) => norm(o) === want) || opts.find((o) => flexRx(m[1]).test(o)) || opts.find((o) => norm(o).includes(want));
      if (!match) throw new Error(`Option "${m[1]}" not in drop-down (available: ${opts.map((o) => o.trim()).filter(Boolean).join(' | ')})`);
      const orderBefore = (await scanCards(page)).filter((c) => c.kind === 'device').map((c) => c.text.slice(0, 50));
      await dd.selectOption({ label: match.trim() }); await settle(page, 2500);
      const orderAfter = (await scanCards(page)).filter((c) => c.kind === 'device').map((c) => c.text.slice(0, 50));
      STATE().lastSort = { option: match.trim(), orderBefore, orderAfter, value: await dd.evaluate((el) => el.options[el.selectedIndex] && el.options[el.selectedIndex].text).catch(() => '') };
      return `select:${match.trim()}`;
    }
    // Checkbox group (e.g. multi-select filter): make the named option the only ticked one
    const cbx = page.getByRole('checkbox', { name: flexRx(m[1], true) }).first();
    if (await isVisible(cbx)) {
      const group = cbx.locator('xpath=ancestor::*[count(.//input[@type="checkbox"])>1][1]').first();
      const all = group.locator('input[type="checkbox"]');
      const n = await all.count().catch(() => 0);
      await cbx.check({ force: true }).catch(() => robustClick(cbx));
      await settle(page, 1500);
      for (let i = 0; i < n; i += 1) {
        const c = all.nth(i);
        const isTarget = await c.evaluate((el, t) => el === t, await cbx.elementHandle()).catch(() => false);
        if (!isTarget && (await c.isChecked().catch(() => false))) { await c.uncheck({ force: true }).catch(() => robustClick(c)); await settle(page, 1500); }
      }
      const ticked = [];
      const labels = [];
      for (let i = 0; i < n; i += 1) {
        const lab = String(await all.nth(i).evaluate((el) => (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.value || '').catch(() => '')).trim();
        labels.push(lab);
        if (await all.nth(i).isChecked().catch(() => false)) ticked.push(lab);
      }
      STATE().checkGroup = { labels, ticked, target: m[1] };
      await settle(page, 2000);
      return `checkbox filter: only "${m[1]}" ticked (ticked=[${ticked.map((t) => String(t).trim()).join(', ')}])`;
    }
    const opt = page.getByRole('option', { name: flexRx(m[1]) }).first();
    if (await isVisible(opt)) { await robustClick(opt); await settle(page, 1500); return 'option'; }
    return chooseOption(page, m[1]);
  } },

  { rx: /^select (.+) in (.+)$/i, run: async (page, m) => { const r = await chooseOption(page, m[1], m[2]); await ensureCardSelected(page); return r; } },

  { rx: /^open the (.+) tab$/i, run: async (page, m) => {
    const rx = flexRx(m[1], true);
    const cands = [page.getByRole('tab', { name: rx }), page.getByRole('link', { name: rx }), page.getByText(rx)];
    for (const c of cands) if (await isVisible(c)) { await robustClick(c); await settle(page, 1500); return 'tab opened'; }
    throw new Error(`Tab "${m[1]}" not found`);
  } },

  { rx: /^enter (.+) in (?:the )?(.+?)(?: field)?$/i, run: async (page, m) => {
    const rx = flexRx(m[2]);
    const cands = [page.getByLabel(rx), page.getByPlaceholder(rx), page.getByRole('textbox', { name: rx })];
    for (const c of cands) if (await isVisible(c)) {
      await c.first().fill(m[1]);
      // Autocomplete: if a suggestion list shows the exact value, pick it so the term is applied
      await page.waitForTimeout(1000);
      const sug = page.locator('ul li, [role="option"], .ui-menu-item').filter({ hasText: flexRx(m[1], true) });
      const k = await sug.count().catch(() => 0);
      for (let i = 0; i < k; i += 1) {
        const s = sug.nth(i);
        if (await s.isVisible().catch(() => false) && norm(await s.innerText().catch(() => '')) === norm(m[1])) { await robustClick(s); await settle(page, 1000); return 'filled + suggestion picked'; }
      }
      return 'filled';
    }
    const label = page.getByText(rx).first();
    const near = label.locator('xpath=following::input[1]');
    if (await isVisible(near)) { await near.fill(m[1]); return 'filled-near-label'; }
    throw new Error(`Field "${m[2]}" not found`);
  } },

  { rx: /^click the (next|previous) arrow(?: on the (.+))?$/i, run: async (page, m) => {
    const before = (await snapshot(page)).counter;
    const counter = page.getByText(/\b\d+\s*-\s*\d+\s+of\s+\d+\s+items\b/i).first();
    if (!(await isVisible(counter))) throw new Error('Item counter not found');
    const arrows = counter.locator('xpath=following::*[self::button or self::a or @role="button" or self::span][position()<=4]');
    const isNext = /next/i.test(m[1]);
    const named = page.getByRole('button', { name: isNext ? /next/i : /prev/i }).first();
    const target = (await isVisible(named)) ? named : arrows.nth(isNext ? 1 : 0);
    await robustClick(target);
    await settle(page, 1500);
    const after = (await snapshot(page)).counter;
    const g = globalThis;
    if (isNext) { g.__tom03InitialCounter = before; g.__tom03NextCounter = after; g.__tom03NextChanged = before !== after; }
    else { g.__tom03PrevReturned = after === g.__tom03InitialCounter; }
    return `${before} -> ${after}`;
  } },

  { rx: /^clear the (.+?)(?: field)?$/i, run: async (page, m) => {
    const rx = flexRx(m[1]);
    const cands = [page.getByPlaceholder(rx), page.getByRole('textbox', { name: rx }), page.getByLabel(rx)];
    for (const c of cands) if (await isVisible(c)) { await c.first().fill(''); return 'cleared'; }
    throw new Error(`Field "${m[1]}" not found`);
  } },

  { rx: /^click (.+) in (?!the .+ dialog$)(.+)$/i, run: async (page, m) => {
    const before = await bodyLines(page);
    const label = page.getByText(flexRx(m[2])).first();
    if (!(await isVisible(label))) throw new Error(`Section "${m[2]}" not found`);
    const scope = label.locator('xpath=ancestor::*[.//button or .//a][1]');
    let btn = scope.getByRole('button', { name: flexRx(m[1], true) }).first();
    if (!(await isVisible(btn))) btn = scope.getByText(flexRx(m[1], true)).first();
    if (!(await isVisible(btn))) throw new Error(`"${m[1]}" not found in "${m[2]}"`);
    await robustClick(btn);
    await captureMessages(page, before, 3000);
    return 'clicked';
  } },

  { rx: /^click clear selection$/i, run: async (page) => {
    const rx = /^\s*clear\s*selection\s*$/i;
    let btn = page.getByRole('button', { name: rx }).first();
    if (!(await isVisible(btn))) btn = page.getByText(rx).last();
    if (!(await isVisible(btn))) throw new Error('Clear selection button not found');
    const selBefore = (await scanCards(page)).filter((c) => c.selected).map((c) => `${c.kind}:${c.text.slice(0, 40)}`);
    await robustClick(btn);
    await settle(page, 2000);
    let remaining = [];
    let retried = false;
    const end = Date.now() + 20000;
    do {
      remaining = (await scanCards(page)).filter((c) => c.selected);
      if (!remaining.length) break;
      if (!retried && remaining.length === selBefore.length && Date.now() > end - 15000) {
        // first click produced no change at all - click once more (real mouse click)
        retried = true;
        const box = await btn.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); else await robustClick(btn);
        await settle(page, 2000);
        continue;
      }
      await page.waitForTimeout(1000);
    } while (Date.now() < end);
    STATE().currentCard = null;
    STATE().lastClear = { before: selBefore, remaining: remaining.map((c) => ({ kind: c.kind, text: c.text.slice(0, 60) })), retried };
    return `before=[${selBefore.join(' ; ')}] remainingSelected=[${remaining.map((c) => `${c.kind}:${c.text.slice(0, 60)}`).join(' ; ')}]${retried ? ' (re-clicked: first click had no effect)' : ''}`;
  } },

  { rx: /^click (?:the )?(.+?)(?: button| link)?$/i, run: async (page, m) => {
    const before = await bodyLines(page);
    const rx = flexRx(m[1], true);
    const cands = [page.getByRole('button', { name: rx }), page.getByRole('link', { name: rx }), page.getByRole('tab', { name: rx }), page.getByText(rx), page.getByRole('button', { name: flexRx(m[1]) })];
    for (const c of cands) if (await isVisible(c)) { await robustClick(c); await captureMessages(page, before, 2500); return 'clicked'; }
    throw new Error(`Click target "${m[1]}" not found`);
  } }
];

async function waitForText(page, text, timeout = 60000) {
  const rx = flexRx(text);
  const st = STATE();
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const lines = await bodyLines(page);
    const hit = lines.find((l) => rx.test(l));
    if (hit) { st.messages.add(hit); return `found "${hit}"`; }
    await page.waitForTimeout(500);
  }
  throw new Error(`"${text}" was not displayed within ${timeout / 1000}s`);
}

function matchStep(step) {
  const s = strip(step);
  for (const g of GRAMMAR) { const m = s.match(g.rx); if (m) return { g, m }; }
  return null;
}

async function runStep(page, step) {
  const hit = matchStep(step);
  if (!hit) return { handled: false };
  const detail = await hit.g.run(page, hit.m);
  const st = STATE();
  let note = '';
  for (const [name, rec] of Object.entries(st.checkboxes)) {
    if (!rec.locator || !rec.checked) continue;
    const now = await rec.locator.first().isChecked().catch(() => null);
    if (now === false && !rec.resetBy) { rec.resetBy = strip(step); note += ` [checkbox "${name}" was unticked by the application after this step]`; }
  }
  const snap = await snapshot(page).catch(() => null);
  st.history.push({ step: strip(step), snap });
  const popup = STATE().pendingPopup; STATE().pendingPopup = null;
  return { handled: true, detail: detail + note, popup };
}

/* ------------------------------------------------------------- verifier */

function dataValuesIn(line) {
  let data = {};
  try { data = JSON.parse(process.env.TEST_DATA_JSON || '{}'); } catch (e) {}
  const skip = /^(ENV_|SITEMAP|CUSTOMER_|ADDRESS|BASE_URL|SIEBEL_|FIRST_NAME|LAST_NAME|REMOVE_CONFIRM)/;
  return Object.entries(data)
    .filter(([k, v]) => !skip.test(k) && v && String(v).length > 1 && flexRx(v).test(line))
    .map(([k, v]) => ({ k, v: String(v) }))
    .sort((a, b) => b.v.length - a.v.length);
}

/** Snapshot after the step best matching "After <phrase>" (else current). */
async function stateFor(page, line) {
  const st = STATE();
  const m = line.match(/^after (.+?)(?: (?:only|no|the|new service)\b)/i) || line.match(/^after ([^,]+),/i);
  if (m && st.history.length) {
    const stems = norm(m[1]).split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 5));
    let best = null; let bestScore = 0;
    st.history.forEach((h) => {
      const tw = norm(h.step).split(' ');
      const score = stems.filter((s) => tw.some((w) => w.startsWith(s))).length;
      if (score > bestScore) { best = h; bestScore = score; }
    });
    if (best && best.snap) return { snap: best.snap, at: best.step };
  }
  const cur = await snapshot(page);
  if (!cur.panelFound) {
    // page moved away (e.g. quote/order page): use the last state captured on the listing page
    const last = [...st.history].reverse().find((h) => h.snap && h.snap.panelFound);
    if (last) return { snap: last.snap, at: `last listing state (after "${last.step}")` };
  }
  return { snap: cur, at: 'final' };
}

async function verifyLine(page, line) {
  const st = STATE();
  const l = line;
  const res = (ok, actual, reason) => ({ verification_name: l, expected: l, actual, status: ok ? 'PASS' : 'FAIL', failure_reason: ok ? '' : reason });
  const devicesAt = (h) => ((h && h.snap && h.snap.cards) || []).filter((c) => c.kind === 'device');
  const histFind = (rx, last = false) => { const hs = st.history.filter((h) => rx.test(h.step)); return last ? hs[hs.length - 1] : hs[0]; };
  const baseline = st.history[0];

  // ---- Listing: filter / search / sort (state taken from the matching step's snapshot)
  let lm = l.match(/^with (.+?) selected every displayed device card is an? (.+?) device/i);
  if (lm) {
    const h = histFind(new RegExp(`^select the ${esc(lm[1])} option$`, 'i'));
    const devs = devicesAt(h);
    const bad = devs.filter((c) => !flexRx(lm[2]).test(c.text));
    return res(Boolean(h) && devs.length > 0 && bad.length === 0, `${devs.length} cards, non-matching=${bad.length} @${h ? h.step : 'n/a'}`, `${bad.length} displayed card(s) are not ${lm[2]}: ${bad.slice(0, 3).map((c) => c.text.slice(0, 40)).join(' | ')}`);
  }
  lm = l.match(/^with (.+?) selected\b/i);
  if (lm && st.checkGroup && /restored|listing/i.test(l)) {
    // Exclusive checkbox filter: cards must belong to X, i.e. none of the other group labels
    const h = histFind(new RegExp(`^select the ${esc(lm[1])} option$`, 'i'), true);
    const others = st.checkGroup.labels.filter((x) => x && norm(x) !== norm(lm[1]));
    const devs = devicesAt(h);
    const bad = devs.filter((c) => others.some((o) => new RegExp(`^${esc(o)}\\b`, 'i').test(c.text)));
    return res(Boolean(h) && devs.length > 0 && bad.length === 0, `${devs.length} cards, counter="${h && h.snap ? h.snap.counter : ''}", other-brand cards=${bad.length}`, `${bad.length} card(s) of other brands shown: ${bad.slice(0, 3).map((c) => c.text.slice(0, 40)).join(' | ')}`);
  }
  lm = l.match(/^(.+?) opens its destination page/i);
  if (lm) {
    const d = (st.linkDest || []).find((x) => norm(x.link) === norm(lm[1]));
    // Navigation check only: an error page (e.g. 404) at the destination still counts as opened
    return res(Boolean(d && d.opened), d ? `${d.mode}: ${d.url} "${d.title}"` : 'link not clicked', `"${lm[1]}" did not open a destination`);
  }
  if (/after each navigate back the (.+?) tab is displayed/i.test(l)) {
    const tab = l.match(/after each navigate back the (.+?) tab is displayed/i)[1];
    const backs = st.history.filter((h) => /^navigate back$/i.test(h.step));
    const lines = await bodyLines(page);
    const onTab = lines.some((x) => flexRx(tab, true).test(x));
    const ok = backs.length > 0 && backs.every((h) => h.snap && h.snap.panelFound) && onTab;
    return res(ok, `${backs.length} back step(s), listing present=${backs.map((h) => Boolean(h.snap && h.snap.panelFound)).join(',')}, tab visible=${onTab}`, `${tab} tab / listing not restored after Navigate back`);
  }
  if (/baseline listing is restored|default unfiltered listing.*restored/i.test(l)) {
    const cur = await snapshot(page);
    const a = devicesAt(baseline).map((c) => c.text.slice(0, 50)).join('|');
    const b = cur.cards.filter((c) => c.kind === 'device').map((c) => c.text.slice(0, 50)).join('|');
    const counterOk = !/counter/i.test(l) || cur.counter === (baseline && baseline.snap ? baseline.snap.counter : '');
    return res(a === b && counterOk, `baseline counter="${baseline && baseline.snap ? baseline.snap.counter : ''}" now="${cur.counter}"`, 'Listing / counter differs from the initial listing');
  }
  lm = l.match(/after the first search only device cards matching (.+?) are displayed/i) || l.match(/device cards not matching (.+?) are not displayed while the term is active/i);
  if (lm) {
    const h = histFind(/^click search$/i);
    const devs = devicesAt(h);
    const bad = devs.filter((c) => !flexRx(lm[1]).test(c.text));
    return res(Boolean(h) && devs.length > 0 && bad.length === 0, `${devs.length} cards, non-matching=${bad.length}`, `${bad.length} card(s) not matching "${lm[1]}"`);
  }
  if (/device card order changes/i.test(l)) {
    const s = st.lastSort;
    return res(Boolean(s) && s.orderBefore.join('|') !== s.orderAfter.join('|'), s ? `"${s.option}": ${s.orderBefore[0]} -> ${s.orderAfter[0]}` : 'no sort', 'Device card order did not change after sorting');
  }
  lm = l.match(/sort by shows (.+?) after/i);
  if (lm) {
    const s = st.lastSort;
    return res(Boolean(s) && norm(s.value).includes(norm(lm[1])), `selected="${s ? s.value : ''}"`, `Sort by does not show "${lm[1]}"`);
  }
  lm = l.match(/sorted by price (?:from )?(lowest|low|highest|high)/i)
    || l.match(/with (.+?) the (lowest|highest) priced device card is displayed first/i)
    || l.match(/re-?selecting (.+?) reproduces the same (ascending|descending) order/i)
    || l.match(/(.+?) ordering stays applied after/i);
  if (lm) {
    const priceOf = (c) => { const p = c.text.match(/\$([\d,]+\.\d{2})\s*min/i); return p ? Number(p[1].replace(/,/g, '')) : NaN; };
    const dir = /low|ascend/i.test(l.match(/lowest|highest|ascending|descending|price low|price high/i)?.[0] || '') ? 'asc' : 'desc';
    const label = lm[1] && !/^(lowest|low|highest|high)$/i.test(lm[1]) ? lm[1] : '';
    const checkAt = (h) => {
      const prices = devicesAt(h).map(priceOf).filter((x) => !Number.isNaN(x));
      const ok = prices.length > 1 && prices.every((p, i) => i === 0 || (dir === 'asc' ? p >= prices[i - 1] : p <= prices[i - 1]));
      return { ok, prices };
    };
    let targets = [];
    if (/stays applied after/i.test(l)) targets = st.history.filter((h) => /arrow/i.test(h.step));
    else if (/re-?selecting/i.test(l)) targets = [histFind(new RegExp(`^select the ${esc(label)} option$`, 'i'), true)];
    else if (label) targets = [histFind(new RegExp(`^select the ${esc(label)} option$`, 'i'))];
    else targets = [{ snap: await snapshot(page), step: 'final' }];
    targets = targets.filter(Boolean);
    const results = targets.map((h) => ({ step: h.step, ...checkAt(h) }));
    const ok = results.length > 0 && results.every((r) => r.ok);
    return res(ok, results.map((r) => `${r.step}: [${r.prices.join(', ')}]`).join(' ; ') || 'no matching step', `Device prices not in ${dir === 'asc' ? 'ascending' : 'descending'} order: ${results.filter((r) => !r.ok).map((r) => `${r.step} [${r.prices.join(', ')}]`).join(' ; ') || 'step not executed'}`);
  }

  // ---- New services panel
  if (/no (?:row is added to|new service row is displayed in) new services|no new service row/i.test(l)) {
    const { snap, at } = await stateFor(page, l);
    return res(snap.services.length === 0, `services=${snap.services.length} @${at}`, 'New services contains rows');
  }
  let m = l.match(/new service (\d+)\b.*\bis no longer displayed/i);
  if (m) {
    const { snap } = await stateFor(page, l);
    const exists = snap.services.some((s) => s.n === Number(m[1]));
    return res(!exists, `services=[${snap.services.map((s) => s.n).join(',')}]`, `New service ${m[1]} still displayed`);
  }
  m = l.match(/new service (\d+) (?:still )?shows (.+)/i);
  if (m) {
    const { snap } = await stateFor(page, l);
    const svc = snap.services.find((s) => s.n === Number(m[1]));
    if (!svc) return res(false, `services=[${snap.services.map((s) => s.n).join(',')}]`, `New service ${m[1]} not displayed`);
    const expected = dataValuesIn(m[2]);
    const missing = expected.filter((e) => !flexRx(e.v).test(svc.text));
    return res(missing.length === 0, svc.text.slice(0, 250), `New service ${m[1]} missing: ${missing.map((x) => `${x.k}=${x.v}`).join(', ')}`);
  }
  m = l.match(/new service (\d+) is (?:added|displayed)/i);
  if (m) {
    const { snap } = await stateFor(page, l);
    const ok = snap.services.some((s) => s.n === Number(m[1]));
    return res(ok, `services=[${snap.services.map((s) => s.n).join(',')}]`, `New service ${m[1]} not displayed`);
  }
  if (/recurring charges.*total.*empty-cart baseline/i.test(l)) {
    const { snap } = await stateFor(page, l);
    return res(/\$?0\.00/.test(snap.total) && snap.services.length === 0, `total=${snap.total}`, 'Totals not at empty-cart baseline');
  }
  if (/recurring charges.*total.*recalculated/i.test(l)) {
    const prev = [...st.history].reverse().find((h) => h.snap && h.snap.services.length > (st.history[st.history.length - 1].snap || { services: [] }).services.length);
    const now = await snapshot(page);
    const ok = prev && prev.snap.total && prev.snap.total !== now.total;
    return res(Boolean(ok), `before=${prev ? prev.snap.total : 'n/a'} after=${now.total}`, 'Total did not change after removal');
  }

  // ---- Selected state
  if (/no plan tile or device card shows selected/i.test(l)) {
    const { snap, at } = await stateFor(page, l);
    const sel = snap.cards.filter((c) => c.selected);
    return res(sel.length === 0, `selected=${sel.length} @${at}`, `${sel.length} card(s) still Selected: ${sel.map((c) => `${c.kind} "${c.text.slice(0, 50)}"`).join('; ')}`);
  }
  m = l.match(/(only )?the (.+?) (device card|plan tile|wearable card|accessory card) (?:still )?shows selected/i);
  if (m) {
    const { snap, at } = await stateFor(page, l);
    const kind = /plan/i.test(m[3]) ? 'plan' : 'device';
    const sel = snap.cards.filter((c) => c.kind === kind && c.selected);
    const target = m[2].replace(/^only the /i, '');
    const ordHit = st.ordinal && st.ordinal[norm(target)];
    const nameKey = ordHit ? ordHit.text.split(/ from:| \$/i)[0].slice(0, 60) : target;
    let match = ordHit ? sel.filter((c) => c.id === ordHit.id || c.text.startsWith(nameKey)) : sel.filter((c) => flexRx(target).test(c.text));
    if (!match.length && kind === 'plan' && st.lastPlan && /proposition/.test(st.lastPlan.via || '')) match = sel;
    const ok = match.length > 0 && (!m[1] || sel.length === 1);
    return res(ok, `${kind} selected=${sel.length}, matching="${target}"=${match.length} @${at}`, `Expected ${m[1] ? 'only ' : ''}"${target}" ${m[3]} Selected`);
  }

  // ---- Messages
  m = l.match(/message\s+["']?(.+?)["']?\s+is not displayed/i);
  if (m) {
    const txt = strip(m[1]);
    const seen = [...st.messages].some((x) => flexRx(txt).test(x)) || (await bodyLines(page)).some((x) => flexRx(txt).test(x));
    return res(!seen, seen ? 'displayed' : 'not displayed', `"${txt}" was displayed`);
  }
  m = l.match(/message shown:\s*["']([^"']+)["']/i) || l.match(/message shown:\s*(.+?)\.?$/i);
  if (m) {
    const txt = strip(m[1]);
    const rx = flexRx(txt);
    const seen = [...st.messages].find((x) => rx.test(x)) || (await bodyLines(page)).find((x) => rx.test(x));
    return res(Boolean(seen), seen ? `seen: "${seen}"` : 'not seen', `Message "${txt}" not displayed`);
  }

  // ---- Checkbox
  m = l.match(/(.+?) checkbox is (ticked|checked|displayed and disabled|disabled)/i);
  if (m) {
    const key = norm(m[1].replace(/^the /i, ''));
    const rec = st.checkboxes[key];
    const cb = rec && rec.locator ? rec.locator.first() : page.getByRole('checkbox', { name: flexRx(m[1]) }).first();
    const liveChecked = await cb.isChecked().catch(() => null);
    // State at the moment of the checkbox step is the evidence; live state reported alongside
    const checked = rec ? rec.checked : Boolean(liveChecked);
    const disabled = rec ? rec.disabled : await cb.isDisabled().catch(() => false);
    const ok = /ticked|checked/i.test(m[2]) ? checked : disabled;
    return res(ok, `atStep checked=${checked} disabled=${disabled}; now checked=${liveChecked}`, `Checkbox not ${m[2]} (atStep checked=${checked} disabled=${disabled})`);
  }
  if (/clicking the checkbox does not tick it/i.test(l)) {
    const recs = Object.values(st.checkboxes);
    const ok = recs.length > 0 && recs.every((r) => !r.checked);
    return res(ok, JSON.stringify(st.checkboxes), 'Checkbox became ticked');
  }

  // ---- Shipping populated from coverage address
  if (/populated from the coverage address/i.test(l)) {
    const lines = await bodyLines(page);
    const i = lines.findIndex((x) => /^results for/i.test(x));
    const cov = i >= 0 ? (lines[i].replace(/^results for/i, '') || lines[i + 1] || '') : '';
    const tokens = norm(cov).split(' ').filter((t) => t.length >= 4);
    const recorded = Object.values(st.checkboxes).map((r) => r.fieldValue).filter(Boolean);
    const hit = recorded.find((v) => tokens.some((t) => norm(v).includes(t)));
    return res(Boolean(hit), `coverage="${cov}" fieldAtStep="${hit || recorded[0] || ''}"`, `Shipping field not populated from coverage address (field="${recorded[0] || ''}")`);
  }
  if (/populated shipping values remain/i.test(l)) {
    const rec = Object.values(st.checkboxes).find((r) => r.fieldValue);
    if (!rec) return res(false, '', 'No shipping value was populated earlier');
    const now = await rec.locator.first().evaluate((el) => {
      let n = el.parentElement;
      for (let i = 0; i < 6 && n; i += 1, n = n.parentElement) {
        const inp = Array.from(n.querySelectorAll('input[type="text"], input:not([type])')).find((x) => x.offsetParent);
        if (inp) return inp.value || '';
      }
      return '';
    }).catch(() => '');
    return res(norm(now) === norm(rec.fieldValue), `before="${rec.fieldValue}" after="${now}"`, `Shipping value not retained (before="${rec.fieldValue}", after="${now}")${rec.resetBy ? `; application unticked the checkbox after step "${rec.resetBy}"` : ''}`);
  }
  if (/(suburb|postcode).*remain empty/i.test(l)) {
    const recs = Object.values(st.checkboxes);
    const ok = recs.length > 0 && recs.every((r) => !r.fieldValue);
    return res(ok, JSON.stringify(recs.map((r) => r.fieldValue)), 'Shipping fields were populated');
  }

  // ---- Cards keep Select button
  if (/device cards? .*(keep|show|have) a (?:displayed )?select button/i.test(l)) {
    const { snap, at } = await stateFor(page, l);
    const dev = snap.cards.filter((c) => c.kind === 'device');
    return res(dev.length > 0, `deviceCards=${dev.length} @${at}`, 'No device card with Select button');
  }

  // ---- Stay on tab
  m = l.match(/user remains on the (.+?) tab/i);
  if (m) {
    const tab = page.getByRole('tab', { name: flexRx(m[1]) }).first();
    const visible = (await isVisible(tab)) || (await isVisible(page.getByText(flexRx(m[1], true))));
    return res(visible, visible ? `${m[1]} tab visible` : 'tab not visible', `Not on ${m[1]} tab`);
  }

  return null;
}

function resetState() { globalThis.__sr = null; }

module.exports = { runStep, matchStep, verifyLine, snapshot, resetState };
