const fs = require('fs/promises');

function normalizeText(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();

}


function extractQuotedText(value) {
	// Return an array of quoted substrings (both single and double quotes).
	if (value == null) return [];
	const s = String(value || '');
	const out = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	let m;
	while ((m = re.exec(s)) !== null) {
		out.push((m[1] !== undefined ? m[1] : m[2]).replace(/\\([\\\"'])/g, '$1'));
	}
	return out;
}
function cleanControlLabel(value) {
    if (!value) return '';

    const v = normalizeText(String(value))
      .replace(/[\/*?]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const cleaned = v.replace(
        /\b(?:tab item|tab|category|button)\b/gi,
        ''
    );

    return normalizeText(cleaned);
}
function escapeSingleQuotes(value) {
	return normalizeText(value)
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'");
}
function escapeRegex(value) {
	// Escape characters that are meaningful in regular expressions so
	// user text can be safely embedded into new RegExp()/literal /.../i
	// Characters escaped: () [] {} .* + ? ^ $ | \ /
	const s = String(value || '');
	return s.replace(/[()\[\]{}.*+?^$|\\\/]/g, '\\$&');
}

function stripExplanatoryClauses(value) {
	// Remove parenthetical or bracketed explanatory clauses that begin with
	// words like 'or', 'alternatively', 'if needed', 'for example'
	if (!value) return '';
	let s = String(value);
	// Remove (...) [...] {...} where the content begins with those keywords
	s = s.replace(/[\(\[\{]\s*(?:or|alternatively|if needed|for example)\b[^\)\]\}]*[\)\]\}]/gi, '');
	return normalizeText(s);
}

function sanitizeLocatorText(value) {
	// First strip explanatory clauses, then remove common control words
	let stripped = stripExplanatoryClauses(value || '');
	// Remove any stray leading/trailing bracket characters that may remain
	stripped = String(stripped).replace(/^[\(\[\{]+|[\)\]\}]+$/g, '').trim();
	return cleanControlLabel(stripped || '');
}

function normalizeStepsInput(testCaseJson = {}) {
	if (Array.isArray(testCaseJson.steps)) {
		return testCaseJson.steps.map((step) => normalizeText(step)).filter(Boolean);
	}
	if (Array.isArray(testCaseJson.Order_Steps)) {
		return testCaseJson.Order_Steps.map((step) => normalizeText(step)).filter(Boolean);
	}
	if (typeof testCaseJson.Order_Steps === 'string') {
		return testCaseJson.Order_Steps
			.split(/\r?\n/)
			.map((s) => String(s || '').trim())
			.filter(Boolean)
			.map((s) => s.replace(/^\s*\d+\s*[\).\-:]?\s*/, ''))
			.map((step) => normalizeText(step))
			.filter(Boolean);
	}
	return [];
}

function deriveJourneyRuntimeOptions(testCaseJson = {}) {
	const steps = normalizeStepsInput(testCaseJson);
	const postVerification = String(testCaseJson.Post_Verification || testCaseJson.PostVerification || '');
	const allText = [...steps, postVerification].join('\n');

	let exampleCustomerName = '';
	const customerMatch = allText.match(/customer\s+name\s+['"]([^'"]+)['"]/i);
	if (customerMatch && customerMatch[1]) {
		exampleCustomerName = normalizeText(customerMatch[1]);
	}

	const nameParts = exampleCustomerName ? exampleCustomerName.split(/\s+/).filter(Boolean) : [];
	const derivedFirstName = nameParts.length ? nameParts[0] : '';
	const derivedLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

	let addressQuery = '';
	const suggestionHints = [];

	for (const step of steps) {
		if (!/address lookup|coverage address|suggested address|search/i.test(step)) continue;
		const quoted = extractQuotedText(step);
		if (!addressQuery && /enter|search/i.test(step) && quoted.length) {
			addressQuery = normalizeText(quoted[0]);
		}
		if (/suggested address|address result|codegen recorded/i.test(step)) {
			for (const value of quoted) {
				const normalized = normalizeText(value);
				if (normalized) suggestionHints.push(normalized);
			}
		}
	}

	if (addressQuery) {
		suggestionHints.push(addressQuery);
	}

	const uniqueHints = [];
	for (const hint of suggestionHints) {
		const normalized = normalizeText(hint);
		if (!normalized) continue;
		if (!uniqueHints.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
			uniqueHints.push(normalized);
		}
	}

	return {
		journeyName: normalizeText(testCaseJson.User_Journey || ''),
		customer: {
			firstName: derivedFirstName,
			lastName: derivedLastName
		},
		addressLookup: {
			query: addressQuery,
			suggestionHints: uniqueHints
		}
	};
}

function generateVisibleControlsLogCode() {
	return `{
	// Diagnostic: enumerate visible controls by role and log accessible names
	const _roles = ['link','button','checkbox','textbox','combobox','tab','menuitem','img'];
	for (const _r of _roles) {
		try {
			const _locs = page.getByRole(_r);
			const _count = await _locs.count();
			for (let _i = 0; _i < _count; _i++) {
				try {
					const _el = _locs.nth(_i);
					if (await _el.isVisible()) {
						const _name = (await _el.getAttribute('aria-label')) || (await _el.getAttribute('name')) || (await _el.getAttribute('title')) || (await _el.getAttribute('alt')) || (await _el.textContent().catch(()=>'')) || '';
						console.log('VISIBLE_CONTROL:', _r, (_name || '').trim().replace(/\\s+/g,' ').substr(0,200));
					}
				} catch(e) { /* ignore per-element errors */ }
			}
		} catch(e) { /* ignore role errors */ }
	}
}`;
}

function generateCategoryLocatorCode(displayText, regexPattern) {
		// displayText: exact text (string), regexPattern: regex source for contains matching
		// Clean control-type suffixes (e.g. "Mobile phones tab" -> "Mobile phones")
		const _clean = sanitizeLocatorText(displayText);
		const exact = escapeSingleQuotes(_clean);
		const regex = regexPattern ? regexPattern : escapeRegex(_clean);
		return `{
	const _name = '${exact}';
	console.log('TARGET_TEXT_SELECTED:', _name);
	const _roles = ['tab','link','button'];
	let _matched = null;
	let _loc = null;
	for (const _r of _roles) {
		try {
			const _cand = page.getByRole(_r, { name: _name, exact: true }).first();
			if ((await _cand.count()) > 0 && await _cand.isVisible()) { _matched = _r; _loc = _cand; break; }
		} catch(e) { /* ignore */ }
	}
	if (!_matched) {
		try {
			const _exact = page.getByText(_name, { exact: true }).first();
			if ((await _exact.count()) > 0 && await _exact.isVisible()) { _matched = 'textExact'; _loc = _exact; }
		} catch(e) {}
	}
	if (!_matched) {
		try {
			const _contains = page.getByText(/${regex}/i).first();
			if ((await _contains.count()) > 0 && await _contains.isVisible()) { _matched = 'textContains'; _loc = _contains; }
		} catch(e) {}
	}
	console.log('LOCATOR_MATCHED:', _name, '->', _matched);
	await expect(Boolean(_loc && (await _loc.count()) > 0)).toBeTruthy();
}`;
}



function generateLaunchMobilePLPFunction() {
	return [
		'async function launchMobilePLP(page, journeyOptions = {}) {',
		"  const baseUrl = (process.env.BASE_URL || '').trim();",
		"  const firstNameValue = (journeyOptions.customer && journeyOptions.customer.firstName) || (process.env.FIRST_NAME || 'John').trim() || 'John';",
		"  const lastNameValue = (journeyOptions.customer && journeyOptions.customer.lastName) || (process.env.LAST_NAME || 'Citizen').trim() || 'Citizen';",
		"  const addressLookupQuery = (journeyOptions.addressLookup && journeyOptions.addressLookup.query) || (process.env.ADDRESS || '').trim();",
		"  const suggestionHints = Array.isArray(journeyOptions.addressLookup && journeyOptions.addressLookup.suggestionHints) ? journeyOptions.addressLookup.suggestionHints.filter(Boolean) : [];",
		"  const stageScreenshots = (journeyOptions && journeyOptions.stageScreenshots) || {};",
		"  const captureStage = async (stageName) => {",
		"    const targetPath = stageScreenshots[stageName];",
		"    if (!targetPath) return;",
		"    try {",
		"      await page.screenshot({ path: targetPath, fullPage: true });",
		"      console.log('Saved stage screenshot:', targetPath);",
		"    } catch (e) {",
		"      console.log('Failed to save stage screenshot', stageName, e && e.message);",
		"    }",
		"  };",
		"  const waitForAnyVisible = async (locators, timeout = 45000) => {",
		"    const start = Date.now();",
		"    while (Date.now() - start < timeout) {",
		"      for (const loc of locators) {",
		"        try {",
		"          const count = await loc.count();",
		"          if (count > 0) {",
		"            const visible = await loc.first().isVisible().catch(() => false);",
		"            if (visible) return true;",
		"          }",
		"        } catch (e) {}",
		"      }",
		"      await page.waitForTimeout(500);",
		"    }",
		"    return false;",
		"  };",
		"  const clickLocatorRobust = async (locator, timeout = 15000) => {",
		"    try {",
		"      if (!locator || (await locator.count()) <= 0) return false;",
		"      const target = locator.first();",
		"      await target.scrollIntoViewIfNeeded().catch(() => {});",
		"      try { await target.click({ timeout }); return true; } catch (e) {}",
		"      try { await target.click({ timeout, force: true }); return true; } catch (e) {}",
		"      try { await target.evaluate((el) => el.click()); return true; } catch (e) {}",
		"    } catch (e) {}",
		"    return false;",
		"  };",
		"  const waitForCoverageCheckPage = async (timeout = 120000) => {",
		"    const markers = [",
		"      page.getByText(/Coverage check/i).first(),",
		"      page.getByText(/Results for/i).first(),",
		"      page.getByText(/Mobile coverage results/i).first(),",
		"      page.getByText(/Fixed line availability status/i).first(),",
		"      page.getByText(/Fixed wireless availability status/i).first(),",
		"      page.getByText(/NBN details|NDT Details/i).first(),",
		"      page.getByText(/Select wholesaler/i).first(),",
		"      page.getByRole('button', { name: /Next/i }).last(),",
		"    ];",
		"    const start = Date.now();",
		"    while (Date.now() - start < timeout) {",
		"      let visibleCount = 0;",
		"      for (const marker of markers) {",
		"        try {",
		"          if ((await marker.count()) > 0 && await marker.isVisible()) visibleCount += 1;",
		"        } catch (e) {}",
		"      }",
		"      if (visibleCount >= 4) return true;",
		"      await page.waitForTimeout(1000);",
		"    }",
		"    return false;",
		"  };",
		"  const waitForMobilePLP = async (timeout = 120000) => {",
		"    const markers = [",
		"      page.getByRole('button', { name: /Calculate Bundle & Save/i }).first(),",
		"      page.getByRole('button', { name: /Create quote/i }).first(),",
		"      page.getByRole('button', { name: /Create order/i }).first(),",
		"      page.getByText(/Mobile phones/i).first(),",
		"      page.getByText(/Plans/i).first(),",
		"    ];",
		"    const start = Date.now();",
		"    while (Date.now() - start < timeout) {",
		"      let visibleCount = 0;",
		"      for (const marker of markers) {",
		"        try {",
		"          if ((await marker.count()) > 0 && await marker.isVisible()) visibleCount += 1;",
		"        } catch (e) {}",
		"      }",
		"      if (visibleCount >= 3) return true;",
		"      await page.waitForTimeout(1000);",
		"    }",
		"    return false;",
		"  };",
		"  const openSalesCalculatorByUrl = async () => {",
		"    if (!baseUrl) return false;",
		"    try {",
		"      const salesCalculatorUrl = `${baseUrl}?SWECmd=GotoView&SWEView=VHA+SSJ+New+Customer+View&SWERF=1&SWEHo=&SWEBU=1&SWEApplet0=VHA+SSJ+Account+Entry+Applet&SWERowId0=VRId-0`;",
		"      await page.goto(salesCalculatorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});",
		"      return await waitForSalesCalculator(20000);",
		"    } catch (e) {}",
		"    return false;",
		"  };",
		"  const waitForSalesCalculator = async (timeout = 30000) => {",
		"    const markers = [",
		"      page.getByText(/Sales calculator:/i).first(),",
		"      page.getByRole('tab', { name: /Sales calculator/i }).first(),",
		"      page.getByRole('button', { name: /Enter new customer details/i }).first(),",
		"      page.getByText(/Enter new customer details/i).first(),",
		"      page.getByLabel(/First name|First Name/i).first(),",
		"      page.getByText(/Add new service/i).first(),",
		"      page.getByText(/^Mobile$/i).first(),",
		"    ];",
		"    const start = Date.now();",
		"    while (Date.now() - start < timeout) {",
		"      for (const marker of markers) {",
		"        try {",
		"          if ((await marker.count()) > 0 && await marker.isVisible()) return true;",
		"        } catch (e) {}",
		"      }",
		"      await page.waitForTimeout(500);",
		"    }",
		"    return false;",
		"  };",
		"  const openSalesCalculator = async () => {",
		"    if (await waitForSalesCalculator(2000)) return true;",
		"    const salesCalculatorTabCandidates = [",
		"      page.getByRole('tab', { name: /^Sales calculator$/i }).first(),",
		"      page.getByText(/^Sales calculator$/i).first(),",
		"      page.locator('a').filter({ hasText: /^Sales calculator$/i }).first(),",
		"    ];",
		"    for (const candidate of salesCalculatorTabCandidates) {",
		"      try {",
		"        if ((await candidate.count()) > 0 && await candidate.isVisible()) {",
		"          await candidate.scrollIntoViewIfNeeded().catch(() => {});",
		"          await clickLocatorRobust(candidate).catch(() => {});",
		"          if (await waitForSalesCalculator(10000)) return true;",
		"        }",
		"      } catch (e) {}",
		"    }",
		"    const siteMapButton = page.getByRole('menuitem', { name: /Site Map/i }).first();",
		"    if ((await siteMapButton.count()) > 0) {",
		"      await clickLocatorRobust(siteMapButton).catch(() => {});",
		"    } else {",
		"      const toolBarSiteMap = page.getByRole('menuitem', { name: /^Site Map$/i }).nth(1);",
		"      if ((await toolBarSiteMap.count()) > 0) await clickLocatorRobust(toolBarSiteMap).catch(() => {});",
		"    }",
		"    await page.waitForTimeout(1500);",
		"    const firstLevelViewBar = page.getByRole('combobox', { name: /First Level View Bar/i }).first();",
		"    if ((await firstLevelViewBar.count()) > 0) {",
		"      await firstLevelViewBar.selectOption({ label: 'Sales Calculator' }).catch(() => {});",
		"      await firstLevelViewBar.evaluate((el) => {",
		"        el.dispatchEvent(new Event('change', { bubbles: true }));",
		"        el.dispatchEvent(new Event('blur', { bubbles: true }));",
		"      }).catch(() => {});",
		"      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});",
		"      if (await waitForSalesCalculator(15000)) return true;",
		"    }",
		"    const sitemapFilter = page.locator('#sitemapFilterInput').first();",
		"    if ((await sitemapFilter.count()) > 0) {",
		"      await sitemapFilter.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});",
		"      await sitemapFilter.fill('Sales Cal').catch(() => {});",
		"    }",
		"    const salesCalculatorCandidates = [",
		"      page.getByRole('link', { name: /^Sales calculator$/i }).last(),",
		"      page.getByRole('link', { name: /Sales calculator/i }).last(),",
		"      page.locator('a').filter({ hasText: /^Sales calculator$/i }).last(),",
		"      page.getByText(/^Sales calculator$/i).last(),",
		"    ];",
		"    for (const candidate of salesCalculatorCandidates) {",
		"      try {",
		"        if ((await candidate.count()) > 0) {",
		"          await candidate.scrollIntoViewIfNeeded().catch(() => {});",
		"          await clickLocatorRobust(candidate).catch(() => {});",
		"          if (await waitForSalesCalculator(15000)) return true;",
		"        }",
		"      } catch (e) {}",
		"    }",
		"    if (await openSalesCalculatorByUrl()) return true;",
		"    return false;",
		"  };",
		"  const checkForAddressLookup = async (timeout = 30000) => {",
		"    const markers = [",
		"      page.getByText(/address lookup/i).first(),",
		"      page.getByRole('heading', { name: /address lookup/i }).first(),",
		"      page.getByText(/search for address|lookup address|find address/i).first(),",
		"      page.getByRole('textbox', { name: /address|lookup|search/i }).first(),",
		"    ];",
		"    const start = Date.now();",
		"    while (Date.now() - start < timeout) {",
		"      for (const marker of markers) {",
		"        try {",
		"          if ((await marker.count()) > 0 && await marker.isVisible()) return true;",
		"        } catch (e) {}",
		"      }",
		"      await page.waitForTimeout(500);",
		"    }",
		"    return false;",
		"  };",
		"  const completeAddressLookup = async () => {",
		"    const searchField = page.getByRole('textbox', { name: /^Search$/i }).first();",
		"    if ((await searchField.count()) > 0) {",
		"      await searchField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});",
		"      if (addressLookupQuery) await searchField.fill(addressLookupQuery).catch(() => {});",
		"      await searchField.press('Enter').catch(() => {});",
		"      await page.waitForTimeout(1500);",
		"    }",
		"    const dynamicSuggestionCandidates = [];",
		"    for (const hint of suggestionHints) {",
		"      if (!hint) continue;",
		"      if (String(hint).startsWith('#')) {",
		"        dynamicSuggestionCandidates.push(page.locator(String(hint)).first());",
		"        continue;",
		"      }",
		"      const escaped = String(hint).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
		"      const rx = new RegExp(escaped, 'i');",
		"      dynamicSuggestionCandidates.push(page.getByRole('option', { name: rx }).first());",
		"      dynamicSuggestionCandidates.push(page.locator('[role=\"option\"]').filter({ hasText: rx }).first());",
		"      dynamicSuggestionCandidates.push(page.locator('li').filter({ hasText: rx }).first());",
		"      dynamicSuggestionCandidates.push(page.locator('a').filter({ hasText: rx }).first());",
		"    }",
		"    const suggestionCandidates = dynamicSuggestionCandidates.length ? dynamicSuggestionCandidates : [",
		"      page.getByRole('option').first(),",
		"      page.locator('[role=\"option\"]').first(),",
		"      page.locator('li').first(),",
		"      page.locator('a').first(),",
		"    ];",
		"    for (const candidate of suggestionCandidates) {",
		"      try {",
		"        if ((await candidate.count()) > 0 && await candidate.isVisible()) {",
		"          await clickLocatorRobust(candidate).catch(() => {});",
		"          await page.waitForTimeout(1000);",
		"          break;",
		"        }",
		"      } catch (e) {}",
		"    }",
		"  };",
		"  if (baseUrl && !((await page.url()).includes(baseUrl))) {",
		"    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });",
		"  }",
		"  try { console.log('launchMobilePLP: stage=base, url=', await page.url()); } catch(e) {}",
		"  if ((await page.url()).includes('SWECmd=Login') || (await page.locator('#s_swepi_1').count()) > 0) {",
		"    try {",
		"      const uid = page.getByRole('textbox', { name: /User ID|User ID \\*/i }).first();",
		"      const pwd = page.getByRole('textbox', { name: /Password/i }).first();",
		"      if ((await uid.count()) > 0) await uid.fill(process.env.SIEBEL_USERNAME || 'CAREUSER1');",
		"      if ((await pwd.count()) > 0) await pwd.fill(process.env.SIEBEL_PASSWORD || 'CAREUSER1');",
		"      const loginButton = page.getByRole('link', { name: /Login/i }).first();",
		"      if ((await loginButton.count()) > 0) await clickLocatorRobust(loginButton);",
		"      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});",
		"      await page.waitForFunction(() => !window.location.href.includes('SWECmd=Login'), { timeout: 60000 }).catch(() => {});",
		"      await captureStage('login');",
		"    } catch (e) { console.log('launchMobilePLP: login attempt failed', e && e.message); }",
		"  }",
		"  const salesCalculatorReached = await openSalesCalculator();",
		"  if (!salesCalculatorReached) {",
		"    const bodyText = await page.locator('body').innerText().catch(() => '');",
		"    console.log('launchMobilePLP: Sales calculator screen not reached; url=', page.url(), 'bodySnippet=', String(bodyText || '').slice(0, 1200).replace(/\\s+/g, ' '));",
		"    throw new Error('Sales calculator screen was not reached');",
		"  }",
		"  await captureStage('sales-calculator');",
		"  const firstNameField = page.getByLabel(/First name|First Name/i).first();",
		"  const lastNameField = page.getByLabel(/Last name|Last Name/i).first();",
		"  if ((await firstNameField.count()) > 0) await firstNameField.fill(firstNameValue).catch(() => {});",
		"  if ((await lastNameField.count()) > 0) await lastNameField.fill(lastNameValue).catch(() => {});",
		"  const enterDetailsButton = page.getByRole('button', { name: /Enter new customer details/i }).first();",
		"  if ((await enterDetailsButton.count()) > 0) {",
		"    await clickLocatorRobust(enterDetailsButton).catch(() => {});",
		"  }",
		"  const addressLookupReached = await checkForAddressLookup(30000);",
		"  console.log('launchMobilePLP: addressLookupReached=', addressLookupReached, 'url=', page.url());",
		"  if (!addressLookupReached) {",
		"    const bodyText = await page.locator('body').innerText().catch(() => '');",
		"    console.log('launchMobilePLP: address lookup page not detected; bodySnippet=', String(bodyText || '').slice(0, 1000).replace(/\\s+/g, ' '));",
		"    throw new Error('Address lookup page was not reached after Enter new customer details');",
		"  }",
		"  const addressField = page.getByRole('textbox', { name: /Address|Search|Coverage address|Coverage Address|Address line/i }).first();",
		"  if ((await addressField.count()) > 0) {",
		"    await addressField.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});",
		"    if (addressLookupQuery) await addressField.fill(addressLookupQuery).catch(() => {});",
		"  }",
		"  await completeAddressLookup();",
		"  const coverageCheckLoaded = await waitForCoverageCheckPage(120000);",
		"  console.log('launchMobilePLP: coverageCheckLoaded=', coverageCheckLoaded, 'url=', page.url());",
		"  if (!coverageCheckLoaded) {",
		"    throw new Error('Coverage check page did not finish loading after address selection');",
		"  }",
		"  await captureStage('coverage-check');",
		"  const nextAfterCoverageCandidates = [",
		"    page.getByRole('button', { name: /Next/i }).last(),",
		"    page.getByText(/^Next$/i).last(),",
		"  ];",
		"  for (const nextButton of nextAfterCoverageCandidates) {",
		"    if ((await nextButton.count()) > 0) {",
		"      await clickLocatorRobust(nextButton).catch(() => {});",
		"      break;",
		"    }",
		"  }",
		"  const mobilePLPLoaded = await waitForMobilePLP(120000);",
		"  console.log('launchMobilePLP: mobilePLPLoaded=', mobilePLPLoaded, 'url=', page.url());",
		"  if (!mobilePLPLoaded) {",
		"    throw new Error('Mobile PLP did not finish loading after coverage check');",
		"  }",
		"  await captureStage('mobile-plp');",
		"  return;",
		"}",
	].join('\n');
}

function generateClickLocatorCode(targetText) {
    const text = cleanControlLabel(targetText || '') || 'control';
    const safeText = escapeSingleQuotes(text);
    return `{
  const targetText = new RegExp(${JSON.stringify(text)}, 'i');
  const candidates = [
    page.getByRole('button', { name: targetText }).first(),
    page.getByRole('link', { name: targetText }).first(),
    page.getByRole('tab', { name: targetText }).first(),
    page.getByText(targetText).first(),
    page.locator('button, a, [role="button"], [role="tab"], [role="link"]').filter({ hasText: targetText }).first()
  ];
  let matched = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await candidate.count()) > 0 && await candidate.isVisible()) {
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        try {
          await candidate.click({ timeout: 15000 });
          matched = true;
          break;
        } catch (e) {
          try {
            await candidate.click({ timeout: 15000, force: true });
            matched = true;
            break;
          } catch (err) {}
        }
      }
    } catch (e) {}
  }
  if (!matched) {
    throw new Error('Unable to find click target: ${safeText}');
  }
}`;
}

function generateClickBlock(targetText) {
    return generateClickLocatorCode(targetText);
}

function locateSelectedWithinCardForRuntime(target) {
    return `{
  const locateSelectedWithinCard = async (candidate) => {
    if (!candidate) return false;
    try {
      const card = candidate.locator("xpath=ancestor::*[(self::div or self::section or self::article or self::li)][1]").first();
      const cardText = await card.innerText().catch(() => '');
      const className = await card.evaluate((el) => String(el.className || '')).catch(() => '');
      const ariaState = await card.evaluate((el) => {
        const attr = el.getAttribute ? (el.getAttribute('aria-selected') || el.getAttribute('aria-pressed') || el.getAttribute('data-selected') || '') : '';
        return String(attr || '');
      }).catch(() => '');
      return /selected/i.test(String(cardText || '')) || /selected|is-selected|ui-state-active|siebui-active|active/i.test(className) || /selected/i.test(ariaState);
    } catch (e) {
      return false;
    }
  };
  return await locateSelectedWithinCard(target);
}`;
}

function generateSelectedStateAssertion() {
    return `{
  const locateSelectedWithinCard = async (candidate) => {
    if (!candidate) return false;
    try {
      const card = candidate.locator("xpath=ancestor::*[(self::div or self::section or self::article or self::li)][1]").first();
      const cardText = await card.innerText().catch(() => '');
      const className = await card.evaluate((el) => String(el.className || '')).catch(() => '');
      const ariaState = await card.evaluate((el) => {
        const attr = el.getAttribute ? (el.getAttribute('aria-selected') || el.getAttribute('aria-pressed') || el.getAttribute('data-selected') || '') : '';
        return String(attr || '');
      }).catch(() => '');
      return /selected/i.test(String(cardText || '')) || /selected|is-selected|ui-state-active|siebui-active|active/i.test(className) || /selected/i.test(ariaState);
    } catch (e) {
      return false;
    }
  };
  const selectedVisible = Boolean((await page.getByText(/Selected/i).count()) > 0) || Boolean(await locateSelectedWithinCard(page.locator('body')));
  globalThis.__lastObservedSelectedVisible = Boolean(selectedVisible || globalThis.__lastObservedSelectedVisible);
  await expect(Boolean(selectedVisible)).toBeTruthy();
}`;
}

function generateSelectServiceTypeFunction() {
    return `async function selectServiceType(page, visibleText) { return true; }`;
}

function generateEnterTextBlock() {
    return `// Enter text block placeholder`;
}

function generateLoginBlock() {
    return `// Login block placeholder`;
}

function inferFieldName() {
    return '';
}

function generateNavigateSiteMapBlock() {
    return `// Navigate site map placeholder`;
}

function generateLaunchSalesCalculatorBlock() {
    return `// Launch sales calculator placeholder`;
}

function generateActionBlocks(step) {
	const s = normalizeText(step || '');
	if (!s) return [];

	// Ignore reference-only lines
	if (/^\s*(example values|ssj|hld)/i.test(s)) return [];
	if (/^continue to .*when .*shared/i.test(s)) return [];

	const actions = [];
	const isAddToCartStep = /(?:click\s+)?(?:the\s+)?add\s+to\s+cart\b|select\s+add\s+to\s+cart\b|add\s+to\s+basket\b/i.test(s);

	if (/select\s+one\s+compatible\s+plan\s+tile/i.test(s) || /select\s+.*plan.*tile/i.test(s)) {
		actions.push(`{
const clickSelect = async (locator) => {
	await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
	await locator.scrollIntoViewIfNeeded().catch(() => {});
	try { await locator.click({ timeout: 15000 }); }
	catch (e) {
		try { await locator.click({ timeout: 15000, force: true }); }
		catch (forceErr) { await locator.evaluate((el) => el.click()).catch(() => {}); }
	}
};
const planCandidates = [];
for (const btn of await page.locator('button.vha-scj-select-plan').all()) {
	try {
		if (await btn.isVisible()) {
			const hasSelectionState = await btn.evaluate((el) => {
				const text = String((el.innerText || el.textContent || '') || '');
				const className = String(el.className || '');
				const aria = String(el.getAttribute ? (el.getAttribute('aria-selected') || el.getAttribute('aria-pressed') || el.getAttribute('data-selected') || '') : '');
				return /selected/i.test(text) || /selected/i.test(aria) || /selected|is-selected|ui-state-active|siebui-active|active/i.test(className);
			}).catch(() => false);
			if (!hasSelectionState) planCandidates.push(btn);
		}
	} catch (e) {}
}
if (!planCandidates.length) {
	const genericButtons = await page.getByRole('button', { name: /^Select$/i }).all();
	for (const btn of genericButtons) {
		try {
			if (!(await btn.isVisible())) continue;
			const ctx = String(await btn.evaluate((el) => {
				let node = el;
				let text = '';
				for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
					text += ' ' + (node.innerText || node.textContent || '');
				}
				return text.replace(/\s+/g, ' ').toLowerCase();
			}).catch(() => '')).replace(/\s+/g, ' ');
			if (/contract type|national calls|national sms|idd zone|plan|rate plan|unlimited|month to month|rates and charges/.test(ctx)) {
				planCandidates.push(btn);
			}
		} catch (e) {}
	}
}
await expect(planCandidates.length > 0).toBeTruthy();
const chosenPlan = planCandidates[0];
await clickSelect(chosenPlan);
await page.waitForTimeout(1000);
let selectedPlanVisible = false;
for (let i = 0; i < 12; i += 1) {
	const pageSelected = (await page.getByText(/Selected/i).count()) > 0;
	const buttonSelected = (await chosenPlan.getByRole('button', { name: /Selected/i }).count()) > 0;
	const cardSelected = await chosenPlan.evaluate((el) => {
		const text = String((el.innerText || el.textContent || '') || '');
		const className = String(el.className || '');
		const aria = String(el.getAttribute ? (el.getAttribute('aria-selected') || el.getAttribute('aria-pressed') || el.getAttribute('data-selected') || '') : '');
		return /selected/i.test(text) || /selected/i.test(aria) || /selected|is-selected|ui-state-active|siebui-active|active/i.test(className);
	}).catch(() => false);
	selectedPlanVisible = pageSelected || buttonSelected || cardSelected || Boolean(await locateSelectedWithinCard(chosenPlan));
	if (selectedPlanVisible) break;
	await page.waitForTimeout(300);
}
globalThis.__lastPlanSelectionConfirmed = Boolean(selectedPlanVisible);
globalThis.__lastObservedSelectedVisible = Boolean(selectedPlanVisible || globalThis.__lastObservedSelectedVisible);
if (!selectedPlanVisible) {
	const planCard = chosenPlan.locator("xpath=ancestor::*[(self::div or self::section or self::article or self::li)][1]").first();
	const cardText = await planCard.innerText().catch(() => '');
	const selectedMatches = await page.getByText(/Selected/i).allInnerTexts().catch(() => []);
	console.log('TOM08_PLAN_SELECTION_DIAGNOSTIC:', JSON.stringify({
		selectedFound: false,
		planCardText: String(cardText || '').replace(/\s+/g, ' ').slice(0, 500),
		selectedMatches: Array.isArray(selectedMatches) ? selectedMatches.slice(0, 10) : []
	}));
	throw new Error('Compatible plan selection was not confirmed');
}
}`);
	}

	if (isAddToCartStep) {
		actions.push(`{
const cartButtonCandidates = [
  page.getByRole('button', { name: /Add to cart|Add to basket/i }).first(),
  page.getByRole('link', { name: /Add to cart|Add to basket/i }).first(),
  page.getByText(/Add to cart|Add to basket/i).first(),
  page.locator('button, a, [role="button"], [role="link"]').filter({ hasText: /Add to cart|Add to basket/i }).first()
];
let cartClicked = false;
for (const candidate of cartButtonCandidates) {
  try {
    if (!candidate || (await candidate.count()) === 0) continue;
    const target = candidate.first ? candidate.first() : candidate;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await target.click({ timeout: 20000 });
      cartClicked = true;
      break;
    } catch (e) {
      try {
        await target.click({ timeout: 20000, force: true });
        cartClicked = true;
        break;
      } catch (forceErr) {
        try {
          await target.evaluate((el) => el.click());
          cartClicked = true;
          break;
        } catch (evalErr) {}
      }
    }
  } catch (e) {}
}
if (!cartClicked) {
  throw new Error('Unable to find Add to cart control');
}
await page.waitForTimeout(1500);
globalThis.__lastAddToCartAttempted = true;
const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
globalThis.__lastAddToCartBodyText = bodyText.slice(0, 2000);
console.log('ADD_TO_CART_DIAGNOSTIC', bodyText.slice(0, 500));
}`);
	}

	if (/\b(verify|confirm|ensure|check)\b/i.test(s) && !isAddToCartStep) {
		const v = generateVerifyBlock(s);
		if (v) {
			if (/\bselect\b/i.test(s)) {
				if (/select\s+(?:one|a)\s+device/i.test(s) || /select\s+(?:one|a)\s+plan/i.test(s) || /select\s+device\b/i.test(s) || /select\s+plan\b/i.test(s)) {
					const click = `await page.getByRole('button', { name: /Select/i }).first().click();`;
					return [click, v];
				}
			}
			return [v];
		}
	}

	if (/\b(log ?in|sign in|login)\b/i.test(s)) {
		actions.push(generateLoginBlock());
	}

	if (/fill\s+first\s+name\s+and\s+last\s+name/i.test(s) || /first\s+name.*last\s+name.*customer\s+form/i.test(s)) {
		actions.push(`{
const firstNameValue = (process.env.FIRST_NAME || 'John').trim() || 'John';
const lastNameValue = (process.env.LAST_NAME || 'Citizen').trim() || 'Citizen';
const firstNameField = page.getByLabel(/First name|First Name/i).first();
const lastNameField = page.getByLabel(/Last name|Last Name/i).first();
if ((await firstNameField.count()) > 0) {
	await firstNameField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	await firstNameField.fill(firstNameValue).catch(() => {});
}
if ((await lastNameField.count()) > 0) {
	await lastNameField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	await lastNameField.fill(lastNameValue).catch(() => {});
}
}`);
	}

	if (/enter\s+new\s+customer\s+details/i.test(s)) {
		actions.push(`{
const enterDetailsButton = page.getByRole('button', { name: /Enter new customer details/i }).first();
await enterDetailsButton.scrollIntoViewIfNeeded().catch(() => {});
try {
	await enterDetailsButton.click({ timeout: 15000 });
} catch (e) {
	try {
		await enterDetailsButton.click({ timeout: 15000, force: true });
	} catch (forceErr) {
		await enterDetailsButton.evaluate((el) => el.click()).catch(() => {});
	}
}
}`);
	}

	if (/address\s+lookup.*enter/i.test(s)) {
		const quoted = extractQuotedText(s);
		const query = quoted.find(Boolean) || '177 pacific';
		actions.push(`{
const searchField = page.getByRole('textbox', { name: /^Search$/i }).first();
await searchField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
await searchField.fill('${escapeSingleQuotes(query)}');
await searchField.press('Enter').catch(() => {});
await page.waitForTimeout(1500);
}`);
	}

	if (/select\s+the\s+suggested\s+address\s+result/i.test(s)) {
		const quoted = extractQuotedText(s);
		const suggestion = quoted.find((value) => String(value || '').trim()) || '#ui-id-323';
		actions.push(`{
const suggestionCandidates = [
	page.locator('${escapeSingleQuotes(suggestion)}').first(),
	page.getByRole('option').first(),
	page.locator('[role="option"]').filter({ hasText: rx }).first(),
	page.locator('li').filter({ hasText: rx }).first(),
	page.locator('a').filter({ hasText: rx }).first(),
];
for (const candidate of suggestionCandidates) {
	try {
		if ((await candidate.count()) > 0 && await candidate.isVisible()) {
			await candidate.click().catch(() => {});
			await page.waitForTimeout(1000);
			break;
		}
	} catch (e) {}
}`);
	}

	if (/wait\s+for\s+the\s+customer-details\/coverage-check\s+page\s+to\s+finish\s+loading/i.test(s)) {
		actions.push(`{
await expect(page.getByText(/Coverage check|network areas|available network details/i)).toBeVisible();
const nextButton = page.getByRole('button', { name: /Next/i }).last();
if ((await nextButton.count()) > 0) await nextButton.click().catch(() => {});
}`);
	}

	if (/open\s+the\s+mobile\s*plp\s+tab/i.test(s)) {
		actions.push(`{
const tabCandidates = [
	page.getByRole('tab', { name: /Mobile phones|Mobile PLP/i }).first(),
	page.getByText(/Mobile phones|Mobile PLP/i).first(),
	page.locator('a').filter({ hasText: /Mobile phones|Mobile PLP/i }).first(),
];
for (const candidate of tabCandidates) {
	try {
		if ((await candidate.count()) > 0 && await candidate.isVisible()) {
			await candidate.click().catch(() => {});
			break;
		}
	} catch (e) {}
}
}`);
	}

	return actions;
}

function generateActionBlock(step) {
    const s = normalizeText(step || '');
    if (!s) return '';
    const blocks = (typeof generateActionBlocks === 'function' ? generateActionBlocks(s) : []) || [];
    const cleaned = blocks
        .map((code) => String(code || '').trim())
        .filter(Boolean);
    if (!cleaned.length) {
        return `// Unmapped step: ${escapeSingleQuotes(s)}`;
    }
    return cleaned.join('\n');
}

function generateVerifyBlock(step) {
	const text = normalizeText(step || '');
	if (/\bsame\s+as\b/i.test(text)) {
		return `// Manual verification required: ${escapeSingleQuotes(text)}`;
	}

	if (/previously selected device remains retained/i.test(text) || /selected device remains retained/i.test(text)) {
		return [
			"// Verify previously selected device remains retained after pagination",
			"{",
			"  const savedTitle = globalThis.__tom03SelectedDeviceTitle || '';",
			"  const savedSnippet = globalThis.__tom03SelectedDeviceSnippet || '';",
			"  const savedCounter = globalThis.__tom03InitialCounter || '';",
			"  const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\\s+/g, ' ');",
			"  const titleRetained = savedTitle ? bodyText.includes(savedTitle) : false;",
			"  const snippetRetained = savedSnippet ? bodyText.includes(savedSnippet) : false;",
			"  const counterText = await page.getByText(/\\b\\d+\\s*-\\s*\\d+\\s+of\\s+\\d+\\s+items\\b/i).first().innerText().catch(() => '');",
			"  const counterReturned = savedCounter ? counterText.replace(/\\s+/g, ' ').trim() === savedCounter : false;",
			"  globalThis.__tom03SelectionRetained = Boolean((titleRetained || snippetRetained) && counterReturned);",
			"  await expect(globalThis.__tom03SelectionRetained).toBeTruthy();",
			"}"
		].join('\n');
	}

	if (/selected device state changes to selected|selected state is applied only to the tapped device tile/i.test(text)) {
		return generateSelectedStateAssertion();
	}

	if (/selected plan state changes to selected|selected state is applied only to the tapped plan tile|marks? that plan as selected|marks? that .*plan.* as selected/i.test(text)) {
		return generateSelectedStateAssertion();
	}

	if (/\b(selected state|confirm selected|confirm Selected state|confirm selection|confirm selected state)\b/i.test(text) || /\bconfirm\b.*\bselected\b/i.test(text)) {
		return `await expect((await page.getByText(/Selected/i).count()) > 0).toBeTruthy();`;
	}

	return `// Manual verification required: ${escapeSingleQuotes(text)}`;
}

function generateGenericBlock(step) {
	const cleaned = cleanControlLabel(step || 'step');
	const safe = escapeSingleQuotes(cleaned || step || 'step');
	return `// Unmapped step: ${safe}`;
}

module.exports = {
    normalizeText,
    extractQuotedText,
    cleanControlLabel,
    escapeSingleQuotes,
    escapeRegex,
    stripExplanatoryClauses,
    sanitizeLocatorText,
    normalizeStepsInput,
    deriveJourneyRuntimeOptions,
    generateVisibleControlsLogCode,
    generateCategoryLocatorCode,
    generateLaunchMobilePLPFunction,
    generateSelectServiceTypeFunction,
    generateEnterTextBlock,
    generateLoginBlock,
    inferFieldName,
    generateNavigateSiteMapBlock,
    generateLaunchSalesCalculatorBlock,
    generateClickBlock,
    generateVerifyBlock,
    generateGenericBlock,
    generateActionBlocks,
    generateActionBlock,
    generateClickLocatorCode
};

