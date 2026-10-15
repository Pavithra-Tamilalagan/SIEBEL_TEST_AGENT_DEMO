const { test, expect } = require('@playwright/test');
const path = require('path');

async function launchMobilePLP(page) {
  const baseUrl = (process.env.BASE_URL || '').trim();
  const firstNameValue = (process.env.FIRST_NAME || 'John').trim() || 'John';
  const lastNameValue = (process.env.LAST_NAME || 'Citizen').trim() || 'Citizen';
  const addressLookupQuery = '177 pacific';
  const screenshotsDir = path.join(process.cwd(), 'screenshots');
  const captureStage = async (label) => {
    const safeLabel = String(label).replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const filePath = path.join(screenshotsDir, `TOM_01-${Date.now()}-${safeLabel}.png`);
    await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  };
  const waitForSalesCalculator = async (timeout = 30000) => {
    const markers = [
      page.getByText(/Sales calculator:/i).first(),
      page.getByRole('tab', { name: /Sales calculator/i }).first(),
      page.getByRole('button', { name: /Enter new customer details/i }).first(),
      page.getByText(/Enter new customer details/i).first(),
      page.getByLabel(/First name|First Name/i).first(),
      page.getByText(/Add new service/i).first(),
      page.getByText(/^Mobile$/i).first(),
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const marker of markers) {
        try {
          if ((await marker.count()) > 0 && await marker.isVisible()) return true;
        } catch (e) {}
      }
      await page.waitForTimeout(500);
    }
    return false;
  };
  const waitForCoverageCheckPage = async (timeout = 120000) => {
    const markers = [
      page.getByText(/Coverage check/i).first(),
      page.getByText(/Results for/i).first(),
      page.getByText(/Mobile coverage results/i).first(),
      page.getByText(/Fixed line availability status/i).first(),
      page.getByText(/Fixed wireless availability status/i).first(),
      page.getByText(/NBN details|NDT Details/i).first(),
      page.getByText(/Select wholesaler/i).first(),
      page.getByRole('button', { name: /Next/i }).last(),
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let visibleCount = 0;
      for (const marker of markers) {
        try {
          if ((await marker.count()) > 0 && await marker.isVisible()) visibleCount += 1;
        } catch (e) {}
      }
      if (visibleCount >= 4) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  };
  const waitForMobilePLP = async (timeout = 120000) => {
    const markers = [
      page.getByRole('button', { name: /Calculate Bundle & Save/i }).first(),
      page.getByRole('button', { name: /Create quote/i }).first(),
      page.getByRole('button', { name: /Create order/i }).first(),
      page.getByText(/Mobile phones/i).first(),
      page.getByText(/Plans/i).first(),
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let visibleCount = 0;
      for (const marker of markers) {
        try {
          if ((await marker.count()) > 0 && await marker.isVisible()) visibleCount += 1;
        } catch (e) {}
      }
      if (visibleCount >= 3) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  };
  const openSalesCalculatorByUrl = async () => {
    if (!baseUrl) return false;
    try {
      const salesCalculatorUrl = `${baseUrl}?SWECmd=GotoView&SWEView=VHA+SSJ+New+Customer+View&SWERF=1&SWEHo=&SWEBU=1&SWEApplet0=VHA+SSJ+Account+Entry+Applet&SWERowId0=VRId-0`;
      await page.goto(salesCalculatorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      return await waitForSalesCalculator(20000);
    } catch (e) {}
    return false;
  };
  const openSalesCalculator = async () => {
    if (await waitForSalesCalculator(2000)) return true;

    const salesCalculatorTabCandidates = [
      page.getByRole('tab', { name: /^Sales calculator$/i }).first(),
      page.getByText(/^Sales calculator$/i).first(),
      page.locator('a').filter({ hasText: /^Sales calculator$/i }).first(),
    ];
    for (const candidate of salesCalculatorTabCandidates) {
      try {
        if ((await candidate.count()) > 0 && await candidate.isVisible()) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click().catch(() => {});
          if (await waitForSalesCalculator(10000)) return true;
        }
      } catch (e) {}
    }

    const siteMapButton = page.getByRole('menuitem', { name: /Site Map/i }).first();
    if ((await siteMapButton.count()) > 0) {
      await siteMapButton.click().catch(() => {});
    } else {
      const toolBarSiteMap = page.getByRole('menuitem', { name: /^Site Map$/i }).nth(1);
      if ((await toolBarSiteMap.count()) > 0) await toolBarSiteMap.click().catch(() => {});
    }

    await page.waitForTimeout(1500);

    const firstLevelViewBar = page.getByRole('combobox', { name: /First Level View Bar/i }).first();
    if ((await firstLevelViewBar.count()) > 0) {
      await firstLevelViewBar.selectOption({ label: 'Sales Calculator' }).catch(() => {});
      await firstLevelViewBar.evaluate((el) => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (await waitForSalesCalculator(15000)) return true;
    }

    const sitemapFilter = page.locator('#sitemapFilterInput').first();
    if ((await sitemapFilter.count()) > 0) {
      await sitemapFilter.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await sitemapFilter.fill('Sales Cal').catch(() => {});
    }

    const salesCalculatorCandidates = [
      page.getByRole('link', { name: /^Sales calculator$/i }).last(),
      page.getByRole('link', { name: /Sales calculator/i }).last(),
      page.locator('a').filter({ hasText: /^Sales calculator$/i }).last(),
      page.getByText(/^Sales calculator$/i).last(),
    ];

    for (const candidate of salesCalculatorCandidates) {
      try {
        if ((await candidate.count()) > 0) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click().catch(() => {});
          if (await waitForSalesCalculator(15000)) return true;
        }
      } catch (e) {}
    }

    if (await openSalesCalculatorByUrl()) return true;

    return false;
  };
  const checkForAddressLookup = async (timeout = 30000) => {
    const markers = [
      page.getByText(/address lookup/i).first(),
      page.getByRole('heading', { name: /address lookup/i }).first(),
      page.getByText(/search for address|lookup address|find address/i).first(),
      page.getByRole('textbox', { name: /address|lookup|search/i }).first(),
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const marker of markers) {
        try {
          if ((await marker.count()) > 0 && await marker.isVisible()) return true;
        } catch (e) {}
      }
      await page.waitForTimeout(500);
    }
    return false;
  };
  const completeAddressLookup = async () => {
    const searchField = page.getByRole('textbox', { name: /^Search$/i }).first();
    if ((await searchField.count()) > 0) {
      await searchField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await searchField.fill(addressLookupQuery).catch(() => {});
      await searchField.press('Enter').catch(() => {});
      await page.waitForTimeout(1500);
    }

    const suggestionCandidates = [
      page.locator('#ui-id-323').first(),
      page.getByRole('option', { name: /177.*Pacific/i }).first(),
      page.locator('[role="option"]').filter({ hasText: /177.*Pacific/i }).first(),
      page.locator('li').filter({ hasText: /177.*PACIFIC/i }).first(),
      page.locator('a').filter({ hasText: /177.*PACIFIC/i }).first(),
    ];

    for (const candidate of suggestionCandidates) {
      try {
        if ((await candidate.count()) > 0 && await candidate.isVisible()) {
          await candidate.click().catch(() => {});
          await page.waitForTimeout(1000);
          break;
        }
      } catch (e) {}
    }
  };
  const waitForAnyVisible = async (locators, timeout = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const loc of locators) {
        try {
          const count = await loc.count();
          if (count > 0) {
            const visible = await loc.first().isVisible().catch(() => false);
            if (visible) return true;
          }
        } catch (e) {}
      }
      await page.waitForTimeout(500);
    }
    return false;
  };

  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  if ((await page.url()).includes('SWECmd=Login') || (await page.locator('#s_swepi_1').count()) > 0) {
    const uid = page.getByRole('textbox', { name: /User ID|User ID \*/i }).first();
    const pwd = page.getByRole('textbox', { name: /Password/i }).first();
    if ((await uid.count()) > 0) await uid.fill(process.env.SIEBEL_USERNAME || 'CAREUSER1');
    if ((await pwd.count()) > 0) await pwd.fill(process.env.SIEBEL_PASSWORD || 'CAREUSER1');
    const loginButton = page.getByRole('link', { name: /Login/i }).first();
    if ((await loginButton.count()) > 0) await loginButton.click();
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await captureStage('after-login');
  }

  const salesCalculatorReached = await openSalesCalculator();
  if (!salesCalculatorReached) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log('launchMobilePLP: Sales calculator screen not reached; url=', page.url(), 'bodySnippet=', String(bodyText || '').slice(0, 1200).replace(/\s+/g, ' '));
    throw new Error('Sales calculator screen was not reached');
  }
  await captureStage('sales-calculator-opened');

  const firstNameField = page.getByLabel(/First name|First Name/i).first();
  const lastNameField = page.getByLabel(/Last name|Last Name/i).first();
  if ((await firstNameField.count()) > 0) await firstNameField.fill(firstNameValue).catch(() => {});
  if ((await lastNameField.count()) > 0) await lastNameField.fill(lastNameValue).catch(() => {});
  await captureStage('customer-details-filled');

  const enterDetailsButton = page.getByRole('button', { name: /Enter new customer details/i }).first();
  if ((await enterDetailsButton.count()) > 0) {
    await enterDetailsButton.click().catch(() => {});
  }

  const addressLookupReached = await checkForAddressLookup(30000);
  console.log('launchMobilePLP: addressLookupReached=', addressLookupReached, 'url=', page.url());
  if (!addressLookupReached) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log('launchMobilePLP: address lookup page not detected; bodySnippet=', String(bodyText || '').slice(0, 1000).replace(/\s+/g, ' '));
    throw new Error('Address lookup page was not reached after Enter new customer details');
  }
  await captureStage('address-lookup-opened');

  const addressField = page.getByRole('textbox', { name: /Address|Search|Coverage address|Coverage Address|Address line/i }).first();
  if ((await addressField.count()) > 0) {
    await addressField.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    await addressField.fill(addressLookupQuery).catch(() => {});
  }

  await completeAddressLookup();

  const coverageCheckLoaded = await waitForCoverageCheckPage(120000);
  console.log('launchMobilePLP: coverageCheckLoaded=', coverageCheckLoaded, 'url=', page.url());
  await captureStage('coverage-check-loaded');
  if (!coverageCheckLoaded) {
    throw new Error('Coverage check page did not finish loading after address selection');
  }

  const nextAfterCoverageCandidates = [
    page.getByRole('button', { name: /Next/i }).last(),
    page.getByText(/^Next$/i).last(),
  ];
  for (const nextButton of nextAfterCoverageCandidates) {
    if ((await nextButton.count()) > 0) {
      await nextButton.click().catch(() => {});
      break;
    }
  }

  const mobilePLPLoaded = await waitForMobilePLP(120000);
  console.log('launchMobilePLP: mobilePLPLoaded=', mobilePLPLoaded, 'url=', page.url());
  await captureStage('mobile-plp-loaded');
  if (!mobilePLPLoaded) {
    throw new Error('Mobile PLP did not finish loading after coverage check');
  }

  return;
}

async function selectRandomDeviceAndPlan(page) {
  const clickCard = async (card) => {
    const btn = card.getByRole('button', { name: /Select|Selected|Choose|View/i }).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 20000 }).catch(() => btn.click({ timeout: 20000, force: true }));
      return true;
    }
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.click({ timeout: 20000 }).catch(() => card.click({ timeout: 20000, force: true }));
    return true;
  };

  const selectByVisibleText = async (patterns, label) => {
    for (const pattern of patterns) {
      const matches = await page.getByText(pattern).all();
      for (const match of matches) {
        try {
          if (!(await match.isVisible().catch(() => false))) continue;
          const card = match.locator("xpath=ancestor::*[(self::div or self::section or self::article or self::li) and .//button[normalize-space()='Select' or normalize-space()='Selected' or normalize-space()='Choose' or normalize-space()='View']][1]").first();
          if ((await card.count()) > 0 && (await card.isVisible().catch(() => false))) {
            await clickCard(card);
            console.log('Selected by visible text:', label);
            return true;
          }
        } catch (e) {}
      }

      const directCards = page.locator('div,section,article,li').filter({ hasText: pattern });
      const total = await directCards.count().catch(() => 0);
      for (let i = 0; i < total; i += 1) {
        try {
          const card = directCards.nth(i);
          if (!(await card.isVisible().catch(() => false))) continue;
          const candidateSelectButton = card.getByRole('button', { name: /^Select$|^Selected$|^Choose$|^View$/i }).first();
          if ((await candidateSelectButton.count()) <= 0) continue;
          await clickCard(card);
          console.log('Selected by visible text:', label);
          return true;
        } catch (e) {}
      }
    }
    return false;
  };

  const classifySelectButtons = async () => {
    const buttons = page.getByRole('button', { name: /Select/i });
    const deviceButtons = [];
    const planButtons = [];
    const fallbackButtons = [];
    const totalButtons = await buttons.count();
    for (let i = 0; i < totalButtons; i += 1) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      fallbackButtons.push(btn);
      const ctx = String(await btn.evaluate((el) => {
        let node = el;
        let text = '';
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          text += ' ' + ((node.innerText || node.textContent || '') + ' ');
        }
        return text.replace(/\s+/g, ' ').toLowerCase();
      }).catch(() => '')).replace(/\s+/g, ' ');
      if (/contract type|national calls|national sms|idd zone|plan|rate plan|unlimited|month to month|rates and charges/.test(ctx)) {
        planButtons.push(btn);
      } else if (/device|mobile phones|stock|price|colour|color|storage|check store stock|selected device|carrier|brand/.test(ctx)) {
        deviceButtons.push(btn);
      }
    }
    return { deviceButtons, planButtons, fallbackButtons };
  };

  const safeRandom = (items) => items[Math.floor(Math.random() * items.length)];
  const choose = async (buttons) => {
    if (!buttons.length) return false;
    const btn = safeRandom(buttons);
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 20000 }).catch(() => btn.click({ timeout: 20000, force: true }));
    return true;
  };

  const devicePatterns = [/Apple\s*iPhone\s*17(?:\s*Pro\s*Max)?/i];
  if (!(await selectByVisibleText(devicePatterns, 'Apple iPhone 17')) ) {
    const { deviceButtons, fallbackButtons } = await classifySelectButtons();
    if (!(await choose(deviceButtons.length ? deviceButtons : fallbackButtons))) {
      throw new Error('No visible device Select buttons found');
    }
  }

  await page.waitForTimeout(1000);

  const planPatterns = [/Small\s+MTM\s*-\s*plan/i, /Medium\s+MTM\s*-\s*plan/i, /Large\s+MTM\s*-\s*plan/i];
  let planSelected = false;
  for (const pattern of planPatterns) {
    if (await selectByVisibleText([pattern], String(pattern))) {
      planSelected = true;
      break;
    }
  }

  if (!planSelected) {
    const { planButtons, fallbackButtons } = await classifySelectButtons();
    if (!(await choose(planButtons.length ? planButtons : fallbackButtons))) {
      throw new Error('No visible plan Select buttons found');
    }
  }
}

test('TOM_01', async ({ page }) => {
  const screenshotsDir = path.join(process.cwd(), 'screenshots');
  const captureSuccessStage = async (label) => {
    const safeLabel = String(label).replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const filePath = path.join(screenshotsDir, `TOM_01-pass-${Date.now()}-${safeLabel}.png`);
    await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  };
  const clickActionButton = async (namePattern) => {
    const btn = page.getByRole('button', { name: namePattern }).first();
    await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await btn.click({ timeout: 15000 });
    } catch (e) {
      try {
        await btn.click({ timeout: 15000, force: true });
      } catch (forceErr) {
        await btn.evaluate((el) => el.click()).catch(() => {});
      }
    }
  };
  const waitForOrderProgressState = async (timeout = 30000) => {
    const markers = [
      page.getByRole('button', { name: /Create order/i }).first(),
      page.getByText(/Order summary|Order Summary|Quote summary|Quote Summary|Review order|Order review/i).first(),
      page.getByText(/Values not updated|Bundle and save calculation is completed/i).first(),
    ];
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const marker of markers) {
        try {
          if ((await marker.count()) > 0 && await marker.isVisible()) return true;
        } catch (e) {}
      }
      await page.waitForTimeout(1000);
    }
    return false;
  };
  const getVisiblePopupText = async () => {
    const popupSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.ui-dialog',
      '.modal',
      '.popup',
      '.siebui-popup',
    ];
    for (const selector of popupSelectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const popup = loc.nth(i);
        if (!(await popup.isVisible().catch(() => false))) continue;
        const text = ((await popup.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  };
  const getVisiblePopup = async () => {
    const popupSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '.ui-dialog',
      '.modal',
      '.popup',
      '.siebui-popup',
      'div:has-text("System Alert")',
    ];
    for (const selector of popupSelectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const popup = loc.nth(i);
        if (!(await popup.isVisible().catch(() => false))) continue;
        const text = ((await popup.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (text) return { popup, text };
      }
    }
    return null;
  };
  const closeVisiblePopup = async () => {
    const visiblePopup = await getVisiblePopup();
    const popupScope = visiblePopup?.popup;
    const closeCandidates = [
      popupScope?.getByRole('button', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      popupScope?.getByRole('link', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      popupScope?.getByText(/^Close$/i).last(),
      popupScope?.locator('button, a, span').filter({ hasText: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      page.getByRole('button', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      page.getByRole('link', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      page.getByText(/^Close$/i).last(),
      page.locator('[role="dialog"] button, [role="dialog"] a').filter({ hasText: /Close|OK|Ok|Dismiss|Continue/i }).first(),
      page.locator('.ui-dialog button, .ui-dialog a').filter({ hasText: /Close|OK|Ok|Dismiss|Continue/i }).first(),
    ];
    for (const candidate of closeCandidates) {
      if (!candidate) continue;
      try {
        if ((await candidate.count()) > 0 && await candidate.isVisible()) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click({ timeout: 10000 }).catch(() => candidate.click({ timeout: 10000, force: true }));
          return true;
        }
      } catch (e) {}
    }
    if (popupScope) {
      const clickedViaDom = await popupScope.evaluate((root) => {
        const candidates = Array.from(root.querySelectorAll('*'));
        const target = candidates.find((el) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          return /^Close$/i.test(text);
        });
        if (target && typeof target.click === 'function') {
          target.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (clickedViaDom) return true;
    }
    await page.keyboard.press('Escape').then(() => true).catch(() => false);
    if (!(await getVisiblePopup())) return true;
    return false;
  };
  const waitForPopupToClose = async (timeout = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const visiblePopup = await getVisiblePopup();
      if (!visiblePopup) return true;
      await page.waitForTimeout(500).catch(() => {});
    }
    return false;
  };
  const validateCreateOrderOutcome = async (timeout = 20000) => {
    const start = Date.now();
    let ssjWarningDismissed = false;
    while (Date.now() - start < timeout) {
      const visiblePopup = await getVisiblePopup();
      const popupText = visiblePopup?.text || '';
      if (popupText) {
        console.log('Create order popup:', popupText);
        if (/VHA SSJ Credit Check Passed Flg|Credit Check Passed Flg|SBL-EXL-00147/i.test(popupText)) {
          const closed = await closeVisiblePopup();
          if (!closed) {
            throw new Error(`Create order warning appeared but could not be dismissed: ${popupText}`);
          }
          const popupClosed = await waitForPopupToClose(10000);
          if (!popupClosed) {
            if (ssjWarningDismissed) {
              throw new Error(`Create order blocked: recurring SSJ credit-check warning after retry. Popup: ${popupText}`);
            }
            throw new Error(`Create order warning remained visible after Close: ${popupText}`);
          }
          ssjWarningDismissed = true;
          console.log('Dismissed known SSJ warning popup; waiting to confirm whether navigation still progresses.');
          await page.waitForTimeout(1500).catch(() => {});
          continue;
        }
        if (/error|unable|failed|cannot|can't|invalid|mandatory|please complete|please enter|not updated|warning|exception/i.test(popupText)) {
          throw new Error(`Create order blocked by popup: ${popupText}`);
        }
      }

      const pageText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      if (/Customer details|ID details|Credit check|Order summary|Order Summary|Review order|Order review|Order details|Order submitted|Order created/i.test(pageText)) {
        const popupStillVisible = await getVisiblePopupText();
        if (popupStillVisible) {
          await page.waitForTimeout(1000).catch(() => {});
          continue;
        }
        return true;
      }
      if (/error|unable to process|failed to create order|please complete|mandatory fields|Values not updated/i.test(pageText)) {
        throw new Error(`Create order failed after click: ${pageText.slice(0, 1200)}`);
      }

      await page.waitForTimeout(1000).catch(() => {});
    }
    return false;
  };

  await launchMobilePLP(page);
  await selectRandomDeviceAndPlan(page);
  await captureSuccessStage('device-and-plan-selected');
  await clickActionButton(/Add to cart|Add to basket/i);

  await page.waitForTimeout(2500);
  const pageText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const hasBlockingSelectionError = /Please select plan or device|Please select plan\.?|PlanNull|No new services added/i.test(pageText);
  const hasCartSuccess = /Cart updated|Changes have been made to your order successfully|New service|New services/i.test(pageText);
  if (hasBlockingSelectionError || !hasCartSuccess) {
    throw new Error('Add to cart failed: no valid device/plan selection was added to cart');
  }
  await captureSuccessStage('add-to-cart-success');

  await clickActionButton(/Calculate Bundle & Save/i);
  await page.waitForTimeout(2000);
  await captureSuccessStage('calculate-bundle-save-clicked');
  await clickActionButton(/Create quote/i);
  await waitForOrderProgressState(30000);
  await captureSuccessStage('create-quote-clicked');

  const createOrderButton = page.getByRole('button', { name: /Create order/i }).first();
  if ((await createOrderButton.count()) > 0 && await createOrderButton.isVisible().catch(() => false)) {
    await clickActionButton(/Create order/i);
    console.log('Clicked Create order');
    await captureSuccessStage('create-order-clicked');
    const createOrderSucceeded = await validateCreateOrderOutcome(20000);
    if (!createOrderSucceeded) {
      throw new Error('Create order click did not reach an order progress page');
    }
    await captureSuccessStage('create-order-progressed');
  } else {
    throw new Error('Create order button was not reachable after Create quote');
  }
});
