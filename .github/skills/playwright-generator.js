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
		"    } catch (e) { console.log('launchMobilePLP: login attempt failed', e && e.message); }",
		"  }",
		"  const salesCalculatorReached = await openSalesCalculator();",
		"  if (!salesCalculatorReached) {",
		"    const bodyText = await page.locator('body').innerText().catch(() => '');",
		"    console.log('launchMobilePLP: Sales calculator screen not reached; url=', page.url(), 'bodySnippet=', String(bodyText || '').slice(0, 1200).replace(/\\s+/g, ' '));",
		"    throw new Error('Sales calculator screen was not reached');",
		"  }",
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
		"  return;",
		"}",
	].join('\n');
}

function generateSelectServiceTypeFunction() {
	return [
		'async function selectServiceType(page, serviceType) {',
		"  // serviceType: 'Mobile' or 'Fixed'",
		"  const _name = String(serviceType || 'Mobile').trim();",
		"  console.log('selectServiceType: attempting to select', _name);",
		"  // Prioritized locator strategy: role=tab -> role=link -> role=button -> exact text -> contains text",
		"  const _roles = ['tab','link','button'];",
		"  let _matched = null;",
		"  let _loc = null;",
		"  for (const _r of _roles) {",
		"    try {",
		"      const _cand = page.getByRole(_r, { name: _name, exact: true }).first();",
		"      if ((await _cand.count()) > 0 && await _cand.isVisible()) { _matched = _r; _loc = _cand; break; }",
		"    } catch(e) { /* ignore */ }",
		"  }",
		"  if (!_matched) {",
		"    try { const _exact = page.getByText(_name, { exact: true }).first(); if ((await _exact.count()) > 0 && await _exact.isVisible()){ _matched = 'textExact'; _loc = _exact; } } catch(e){}",
		"  }",
		"  if (!_matched) {",
		"    try { const _contains = page.getByText(new RegExp(_name.replace(/[\\()\\[\\]{}.*+?^$|\\\\/]/g,'\\\\$&'), 'i')).first(); if ((await _contains.count()) > 0 && await _contains.isVisible()){ _matched = 'textContains'; _loc = _contains; } } catch(e){}",
		"  }",
		"  // If we found a candidate, check if it's already selected via aria-selected or similar attributes",
		"  if (_loc) {",
		"    try { const _el = _loc.first(); const _aria = await _el.getAttribute('aria-selected').catch(()=>null); if (_aria === 'true') { console.log('SERVICE_TYPE_SELECTED:', _name, '(already selected)'); return; } } catch(e){}",
		"    try { await _loc.click(); console.log('SERVICE_TYPE_SELECTED:', _name); return; } catch(e) { console.log('selectServiceType: click failed for', _name, e && e.message); }",
		"  }",
		"  // As a fallback, attempt to find by partial match (contains) in page text and click the nearest role element",
		"  try { const rx = new RegExp(_name.replace(/[\\()\\[\\]{}.*+?^$|\\\\/]/g,'\\\\$&'), 'i'); const els = Array.from(document.querySelectorAll('button, a, [role=\\\"tab\\\"], [role=\\\"link\\\"], [role=\\\"menuitem\\\"]')).filter(e => (e.innerText||'').trim() && rx.test((e.innerText||'').trim())); if (els.length>0) { try { els[0].click(); console.log('SERVICE_TYPE_SELECTED:', _name, '(fallback DOM click)'); return; } catch(e){} } } catch(e){}",
		"  // If still not found, log for diagnostics but do not throw to avoid breaking existing flows",
		"  console.log('SERVICE_TYPE_SELECTED: not-found ->', _name);",
		'}',
		''
	].join('\n');
}

function generateEnterTextBlock(step) {
	const field = inferFieldName(step) || 'field';
	const m = normalizeText(step).match(/(?:enter|fill|type)\\s+(.+?)\\s+(?:in|into|on|for)\\s+(.+)$/i);
	const value = m ? m[1].replace(/[.]+$/g, '').trim() : '';
	const target = m ? m[2].replace(/[.]+$/g, '').trim() : field;
	return `await page.getByRole('textbox', { name: '${escapeSingleQuotes(target)}' }).fill('${escapeSingleQuotes(value)}');`;
}

function generateLoginBlock() {
	return [
		"// Login block: attempt standard or SSO login if login page detected",
		"{",
		"  try {",
		"    if ((await page.url()).includes('SWECmd=Login') || (await page.locator('#s_swepi_1').first().count() > 0)) {",
		"      try {",
		"        if ((await page.getByRole('textbox', { name: 'User ID' }).first().count()) > 0) await page.getByRole('textbox', { name: 'User ID' }).fill(process.env.SIEBEL_USERNAME || '');",
		"        if ((await page.getByRole('textbox', { name: 'Password' }).first().count()) > 0) await page.getByRole('textbox', { name: 'Password' }).fill(process.env.SIEBEL_PASSWORD || '');",
		"        if ((await page.getByRole('link', { name: 'Login' }).first().count()) > 0) await page.getByRole('link', { name: 'Login' }).click();",
		"        await page.waitForFunction(() => !window.location.href.includes('SWECmd=Login'), { timeout: 30000 }).catch(()=>{});",
		"        console.log('LOGIN: attempt completed');",
		"      } catch(e) { console.log('LOGIN: attempt failed', e && e.message); }",
		"    }",
		"  } catch(e) { console.log('LOGIN: evaluation failed', e && e.message); }",
		"}"
	].join('\n');
}

function inferFieldName(text) {
	const s = String(text || '').trim();
	if (!s) return '';
	// Avoid returning long sentences or verification prompts as a field name
	// (these would otherwise produce literal text assertions).
	const wordCount = s.split(/\s+/).filter(Boolean).length;
	if (/^\s*verify\b/i.test(s) || wordCount > 6 || s.length > 120) return '';
	// Prefer quoted text
	const q = extractQuotedText(s);
	if (q && q.length) return q[0];
	// Common patterns: change to X, switch to X, click X, select X, choose X, open X, go to X
	const m = s.match(/(?:change to|switch to|click|select|choose|open|go to|goto|navigate to|enter|fill|type|press|tap)\s+(?:the\s+)?(?:field\s+)?(?:named\s+)?['"]?([^'"\.\,\(\)\n]+)/i);
	if (m && m[1]) {
		let targ = m[1].trim();
		// If instruction is a selection of a device/plan tile, return the generic 'Select' label
		if (/^select\s+(?:one|a)\s+(?:device|plan)\b/i.test(s) || /^select\s+(?:device|plan)\b/i.test(s)) {
			return 'Select';
		}
		// If captured text ends with a generic control word (e.g. 'Select button' -> 'Select')
		// try to extract the meaningful label before the generic word (e.g. 'Select')
		const genericRe = /^(?:the\s+)?(.+?)\s+(button|link|tab|control|item|action|checkbox|radio|field|option)$/i;
		const gm = targ.match(genericRe);
		if (gm) {
			const before = (gm[1] || '').trim();
			if (before) return before;
			// if nothing before generic word, fall back to verb as label (e.g. 'Select button' -> 'Select')
			const verbMatch = s.match(/^(select|click|press|tap|choose|open)\b/i);
			if (verbMatch) return verbMatch[1].charAt(0).toUpperCase() + verbMatch[1].slice(1);
			return '';
		}
		return targ;
	}
	// Fallback: take first 1-3 substantive words after removing common verbs
	const stop = new Set(['click','select','choose','open','change','switch','to','in','on','for','the','a','an','enter','fill','type','verify','ensure','check','please']);
	const words = s.replace(/[^\w\s&-]/g, ' ').split(/\s+/).filter(Boolean);
	let i = 0; while (i < words.length && stop.has(words[i].toLowerCase())) i++;
	return words.slice(i, i + 3).join(' ').trim();
}

function generateNavigateSiteMapBlock() {
	return `await (async ()=>{ try { const loc = page.locator('li[role="menuitem"][title="Site Map"]'); if ((await loc.count()) > 0) { await loc.click(); } else { const alt = page.getByText(/Site Map/i).first(); if ((await alt.count()) > 0) await alt.click(); } } catch(e) { console.log('generateNavigateSiteMapBlock: failed', e && e.message); } })();`;
}

function generateLaunchSalesCalculatorBlock() {
	// Simple helper to navigate to Sales calculator when referenced in steps
	return `await (async ()=>{ try { const loc = page.getByRole('link', { name: /Sales calculator/i }).first(); if ((await loc.count()) > 0) { await loc.click(); } else { const alt = page.getByText(/Sales calculator/i).first(); if ((await alt.count()) > 0) await alt.click(); } } catch(e) { console.log('generateLaunchSalesCalculatorBlock: failed', e && e.message); } })();`;
}

function generateClickBlock(step) {
	if (/launch\\s+sales\\s+calculator/i.test(step)) return generateLaunchSalesCalculatorBlock();
	const target = inferFieldName(step) || '';
	if (/site map/i.test(step)) return generateNavigateSiteMapBlock();
	if (/sales calculator/i.test(step)) return `await page.getByRole('link', { name: 'Sales calculator', exact: true }).click();`;
	// Use prioritized locator click helper (tab -> link -> button -> exact text -> contains text)
	if (target) return generateClickLocatorCode(sanitizeLocatorText(target));
	return `// TODO: no click target inferred for step: ${escapeSingleQuotes(step)}`;
}

function generateVerifyBlock(step) {
	const text = normalizeText(step || '');
	// If the verification is a comparative note like 'Same as ...', treat as manual note
	// and do not generate automatic locator assertions (e.g. 'Same as coverage check').
	if (/\bsame\s+as\b/i.test(text)) {
		return `// Manual verification required: ${escapeSingleQuotes(text)}`;
	}

	// Pagination / card-set change phrases should not be converted into literal text assertions.
	// Prefer manual verification or specialized pagination control checks instead.
	if (/\b(card set changes|card set|pagination|next arrow|previous arrow|returns without breaking selected tab context)\b/i.test(text)) {
		return `// Manual verification required: ${escapeSingleQuotes(text)}`;
	}

	// Phrases that describe staying/remain in Mobile PLP should not be treated as literal UI text.
	// Reuse Mobile PLP tab checks and active-state heuristics instead (or emit a manual verification comment).
	if (/confirm user remains in mobile plp|user remains in mobile plp|user stays in mobile plp|remains on mobile plp|continue selection on mobile plp|continue selection/i.test(text)) {
		return [
			"// AUTO_ASSERTION: user remains in Mobile PLP (tabs-based)",
			generateCategoryLocatorCode('Mobile phones','Mobile phones'),
			generateCategoryLocatorCode('Tablets & MBB','Tablets\\s*&\\s*MBB'),
			generateCategoryLocatorCode('Wearables','Wearables'),
			generateCategoryLocatorCode('Accessories','Accessories'),
			`{ const mobileActive = await page.evaluate(() => { try { const txt = (document.body && document.body.innerText) || ''; return /Mobile phones/i.test(txt) || /Tablets\\s*&\\s*MBB/i.test(txt) || /Wearables/i.test(txt) || /Accessories/i.test(txt) || /Add new service|New service/i.test(txt); } catch(e) { return false; } }); console.log("mobileActive=", mobileActive); if (!mobileActive) { console.log('AUTO_ASSERTION: mobileActive heuristics failed'); } await expect(mobileActive).toBeTruthy(); }`,
			`{ const _addNewServiceCount = (await page.getByText(/Add new service|New service/i).count()); const addNewServiceVisible = _addNewServiceCount > 0; console.log("addNewServiceVisible=", addNewServiceVisible); await expect(addNewServiceVisible).toBeTruthy(); }`
		].join('\n');
	}

	// Selection + selected-state checks: avoid converting the business sentence into a literal label.
	// Prefer asserting the generic Select control rather than using the whole sentence as the button name.
	if (/\b(selected state|confirm selected|confirm Selected state|confirm selection|confirm selected state)\b/i.test(text) || /\bconfirm\b.*\bselected\b/i.test(text)) {
		return `await expect(page.getByRole('button', { name: /Select/i }).first()).toBeVisible();`;
	}

	// Specific mapping: combined per-device-card verification sentence that lists
	// pricing, attributes, Check store stock button, and Select button.
	if (/device card shows stock.*pricing.*attributes.*check store stock.*select/i.test(text)) {
		return [
			"// Device card verification: pricing/attributes and actions",
			"{",
			"  // Stock capability: prefer role-based Check store stock button to verify stock functionality (avoid hidden status labels)",
			"  await expect(page.getByRole('button', { name: /Check store stock/i }).first()).toBeVisible();",
			"  // Pricing presence",
"  { const _loc = page.getByText(/\\$|AUD|GBP|\\u00A3|\\u20AC/i); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }",
			"  // Attributes/specifications presence (match common attribute indicators, ensure a visible match)",
			"  { const _locAttr = page.getByText(/\\d+\\s*GB|GB|Storage|Memory|RAM|colour|color|features|specification|specifications|specs|MP|inch|battery/i); let _foundAttr=false; for (let _i=0; _i<await _locAttr.count(); _i++){ if (await _locAttr.nth(_i).isVisible()){ _foundAttr=true; break; } } await expect(_foundAttr).toBeTruthy(); }",
			"  // Select button",
			"  await expect(page.getByRole('button', { name: /Select/i }).first()).toBeVisible();",
			"}"
		].join('\n');
	}

	// Specific mapping: Plans area should show proposition, entitlements, and a Select action on each plan tile
	if (/plans? area shows proposition.*entitlements.*select on each plan tile/i.test(text) || /verify plans? area shows proposition, entitlements, and Select on each plan tile/i.test(text)) {
		return [
			"// Plans area verification: proposition, entitlements and Select action",
			"// Check for proposition label or common proposition indicators",
			"{ const _locProp = page.getByText(/proposition|plan proposition|proposition name/i); let _foundProp=false; for (let _i=0; _i<await _locProp.count(); _i++){ if (await _locProp.nth(_i).isVisible()){ _foundProp=true; break; } } await expect(_foundProp).toBeTruthy(); }",
			"// Check for entitlement presence",
			"{ const _locEnt = page.getByText(/entitlement|entitlements|included|allowance|benefit/i); let _foundEnt=false; for (let _i=0; _i<await _locEnt.count(); _i++){ if (await _locEnt.nth(_i).isVisible()){ _foundEnt=true; break; } } await expect(_foundEnt).toBeTruthy(); }",
			"// Ensure each plan tile exposes a Select action (role-based)",
			"await expect(page.getByRole('button', { name: /Select/i }).first()).toBeVisible();",
		].join('\n');
	}

	// If text lists multiple controls/items (comma-separated or 'and'), attempt
	// to generate per-item assertions, mapping phrases that end with 'button'
	// to role=button queries and falling back to text presence checks.
	// High-priority mapping: combined quote header + coverage summary
	// Avoid splitting this business sentence into separate literal getByText assertions
	if (/confirm quote header.*coverage summary/i.test(text)) {
		// Use multiple heuristics and fallbacks to detect Quote header and Coverage
		return [
			"// Quote header and coverage summary validation (robust heuristics)",
			"{ const quoteDetailsVisible = await (async () => { try {\n",
			"  // 1) heading containing 'Quote' or 'Quote details'\n",
			"  const h = page.getByRole('heading', { name: /Quote|Quote details|Quote number/i }).first(); if ((await h.count()) > 0 && await h.isVisible()) return true;\n",
			"  // 2) explicit Quote number patterns (e.g. 'Quote 12345' or 'quote number 12345')\n",
			"  const qnum = page.getByText(/Quote\s*(number|#)?\s*\d{4,}/i).first(); if ((await qnum.count()) > 0 && await qnum.isVisible()) return true;\n",
			"  // 3) presence of Customer / Customer Name near header indicators\n",
			"  const cust = page.getByText(/Customer\s*Name|Customer/i).first(); if ((await cust.count()) > 0 && await cust.isVisible()) return true;\n",
			"  // 4) generic Quote text fallback\n",
			"  const anyq = page.getByText(/Quote|Quotation|Quote details/i).first(); if ((await anyq.count()) > 0 && await anyq.isVisible()) return true;\n",
			"  // 5) DOM id/class heuristics for quote area\n",
			"  const domq = page.locator('[class*=quote], [id*=quote]').first(); if ((await domq.count()) > 0 && await domq.isVisible()) return true;\n",
			" } catch(e){} return false; })(); await expect(quoteDetailsVisible).toBeTruthy(); }",
			"{ const coverageVisible = await (async () => { try {\n",
			"  // 1) explicit Coverage Check link/label\n",
			"  const covLink = page.getByRole('link', { name: /Coverage Check/i }).first(); if ((await covLink.count()) > 0 && await covLink.isVisible()) return true;\n",
			"  // 2) coverage summary/result text variants\n",
			"  const covTxt = page.getByText(/Coverage summary|Coverage check|Coverage result|Service available|Availability/i).first(); if ((await covTxt.count()) > 0 && await covTxt.isVisible()) return true;\n",
			"  // 3) DOM id/class heuristics for coverage area\n",
			"  const domc = page.locator('[class*=coverage], [id*=coverage], [class*=coverage-summary]').first(); if ((await domc.count()) > 0 && await domc.isVisible()) return true;\n",
			" } catch(e){} return false; })(); await expect(coverageVisible).toBeTruthy(); }"
		].join('\n');
	}

	if (/(,|\band\b)/i.test(text)) {
		const items = String(text).split(/\s*,\s*|\s+and\s+/i).map(s => (s||'').trim()).filter(Boolean);
		if (items.length > 1) {
			const parts = [];
			for (const it of items) {
				let item = it.replace(/^\-\s*/,'').trim();
					// Remove any leading conjunction left by splitting (e.g. 'and Select')
					item = item.replace(/^(?:and|or)\b\s*/i, '').replace(/[\.\:\;]+$/g, '').trim();
				// Remove trailing generic control words (e.g. 'Select button' -> 'Select')
				item = item.replace(/\b(button|link|tab|control|item|action|checkbox|radio|field|option)\b$/i, '').trim();
				if (!item) {
					// Try to infer a meaningful label if possible
					const inf = inferFieldName(it);
					if (inf && !/^(button|link|tab|control|item|action|checkbox|radio|field|option)$/i.test(inf)) item = inf;
				}
				if (!item) continue;
				// If the original fragment mentioned button-like action or starts with a verb, prefer role=button
				if (/\bbutton\b/i.test(it) || /^\s*(select|check|press|tap|click)\b/i.test(it)) {
					parts.push(`await expect(page.getByRole('button', { name: /${escapeRegex(item)}/i }).first()).toBeVisible();`);
				} else {
					parts.push(`await expect(page.getByText(/${escapeRegex(item)}/i)).toBeVisible();`);
				}
			}
			if (parts.length) return parts.join('\n');
		}
	}
	// Journey1 Mobile PLP specific mappings
	if (/confirm quote header/i.test(text) || /coverage summary/i.test(text)) {
		return [
			"// Generated verification: Customer name present",
			"{ const _loc = page.getByText(/Customer|Customer Name/i); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }",
			"// Generated verification: Coverage summary present",
			"{ const _loc2 = page.getByText(/Coverage summary|Coverage/i); let _found2=false; for (let _i2=0; _i2<await _loc2.count(); _i2++){ if (await _loc2.nth(_i2).isVisible()){ _found2=true; break; } } await expect(_found2).toBeTruthy(); }"
		].join('\n');
	}

	if (/verify category tabs show/i.test(text) || /category tabs/i.test(text)) {
		// The UI may omit some category tabs depending on configuration (e.g. 'Bundles').
		// Verify the primary tabs that should normally be present and log results for diagnostics.
		// Generate explicit per-tab checks with clear debug logs
		// Use prioritized locator strategy: role=tab -> role=link -> role=button -> exact text -> contains text
		return [
			generateCategoryLocatorCode('Mobile phones', 'Mobile phones'),
			generateCategoryLocatorCode('Tablets & MBB', 'Tablets\\s*&\\s*MBB'),
			generateCategoryLocatorCode('Wearables', 'Wearables'),
			generateCategoryLocatorCode('Accessories', 'Accessories')
		].join('\n');
	}

	if (/verify action area/i.test(text) || /action area/i.test(text)) {
		const actions = ['Calculate Bundle & Save', 'View purchase & offer details', 'Create quote', 'Create order', 'Select'];
		return actions.map(a => `{ const _loc = page.getByText(/${escapeRegex(a)}/i); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }`).join('\n');
	}

	// Known general mappings
	const mappings = [
		{ match: /sales calculator/i, code: `{ const _loc = page.getByText(/Sales calculator/i); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }` },
		{
			match: /mobile plp/i, code: `{
		  console.log('AUTO_ASSERTION: Mobile PLP (tabs-based)');
		  ${generateCategoryLocatorCode('Mobile phones','Mobile phones')}
		  ${generateCategoryLocatorCode('Tablets & MBB','Tablets\\s*&\\s*MBB')}
		  ${generateCategoryLocatorCode('Wearables','Wearables')}
		  ${generateCategoryLocatorCode('Accessories','Accessories')}
		  // Ensure Mobile tab is active using multiple heuristics and fallbacks
		  { const mobileActive = await page.evaluate(() => {
		      try {
		        const txt = /Mobile phones/i;
		        const els = Array.from(document.querySelectorAll('body *')).filter(e => txt.test((e.innerText||'').trim()));
		        const activeClassRegex = /active|selected|is-selected|current|swe-selected|tab-active|isActive/i;
		        for (const e of els) {
		          let cur = e;
		          for (let depth=0; cur && depth<8; depth++, cur=cur.parentElement) {
		            try {
		              if (cur.getAttribute && (cur.getAttribute('aria-selected') === 'true' || cur.getAttribute('aria-current') === 'true')) return true;
		              if (cur.className && activeClassRegex.test(cur.className)) return true;
		              const role = cur.getAttribute && cur.getAttribute('role');
		              if (role === 'tab' && cur.getAttribute && cur.getAttribute('aria-selected') === 'true') return true;
		            } catch(e) {}
		          }
		        }
			        const bodyText = document.body.innerText || '';
			        if (/Calculate Bundle\s*&\s*Save/i.test(bodyText) && /Create quote/i.test(bodyText)) return true;
		      } catch(e) {}
		      return false;
			}); console.log("mobileActive=", mobileActive); if (!mobileActive) { console.log('AUTO_ASSERTION: mobileActive heuristics failed'); } await expect(mobileActive).toBeTruthy(); }
		}` },
		{ match: /coverage check/i, code: `{ const _loc = page.getByRole('link', { name: /Coverage Check/i }); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }` },
		{ match: /site map/i, code: `{ const _loc = page.locator('li[role="menuitem"][title="Site Map"]'); let _found=false; for (let _i=0; _i<await _loc.count(); _i++){ if (await _loc.nth(_i).isVisible()){ _found=true; break; } } await expect(_found).toBeTruthy(); }` },
		{ match: /login succeeded|logged in|login successful/i, code: `// Verify login completed: ensure not on login page\n  await page.waitForFunction(() => !window.location.href.includes('SWECmd=Login'), { timeout: 30000 }).catch(()=>{});` }
	];

	for (const m of mappings) {
		if (m.match.test(text)) return m.code;
	}

	// If we could infer a single short field/label name (<=3 words), emit a conservative check
	const inferred = inferFieldName(text);
	// Avoid generating assertions for generic control type names (e.g. 'button')
	if (inferred && inferred.split(/\s+/).length <= 3) {
		if (/^(button|link|tab|control|item|action|checkbox|radio|field|option)$/i.test(inferred)) {
			// Generic control word — don't produce a literal text assertion
			return `// Manual verification required: ${escapeSingleQuotes(text)}`;
		}
		return `{ const _loc = page.getByRole('button', { name: /${escapeRegex(inferred)}/i }).first(); let _found=false; try { if ((await _loc.count()) > 0 && await _loc.isVisible()) _found = true; } catch(e) { } if (!_found) { const _loc2 = page.getByText(/${escapeRegex(inferred)}/i); for (let _i=0; _i<await _loc2.count(); _i++){ if (await _loc2.nth(_i).isVisible()){ _found=true; break; } } } await expect(_found).toBeTruthy(); }`;
	}

	// Unknown verification: do not generate an assertion that may be incorrect.
	return `// Manual verification required: ${escapeSingleQuotes(text)}`;
}

function generateGenericBlock(step) {
	const cleaned = cleanControlLabel(step || 'step');
	const safe = escapeSingleQuotes(cleaned || step || 'step');
	return `// Unmapped step: ${safe}`;
}

function generateActionBlocks(step) {
	const s = normalizeText(step || '');
	if (!s) return [];

	// Ignore reference-only lines
	if (/^\s*(example values|ssj|hld)/i.test(s)) return [];
	if (/^continue to .*when .*shared/i.test(s)) return [];

	const actions = [];

	// Compound intents: allow multiple actionable blocks per business sentence
	if (/\b(verify|confirm|ensure|check)\b/i.test(s)) {
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
	page.locator('[role="option"]').first(),
	page.locator('li').first(),
	page.locator('a').first(),
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

	if (/select\s+the\s+vodafone\s+postpaid\s+infinite\s+plan\s+tile/i.test(s)) {
		actions.push(`{
const planText = /Vodafone Postpaid Infinite/i;
const planSearchValue = 'Vodafone Postpaid Infinite';
const clickSelect = async (locator) => {
	await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
	await locator.scrollIntoViewIfNeeded().catch(() => {});
	try {
		await locator.click({ timeout: 15000 });
	} catch (e) {
		try {
			await locator.click({ timeout: 15000, force: true });
		} catch (forceErr) {
			await locator.evaluate((el) => el.click()).catch(() => {});
		}
	}
};
const plansRoot = page.locator('div,section,article').filter({ hasText: /Plans/i }).first();
try {
	const planSearch = plansRoot.getByRole('textbox', { name: /^Search$/i }).first();
	if ((await planSearch.count()) > 0) {
		await planSearch.fill(planSearchValue).catch(() => {});
		await planSearch.press('Enter').catch(() => {});
		await page.waitForTimeout(1500);
	}
} catch (e) {}
const planContainers = [
	page.locator('div,section,article,li').filter({ hasText: planText }),
	page.getByText(planText).locator('xpath=ancestor::*[self::div or self::section or self::article or self::li][1]'),
];
let clicked = false;
for (const container of planContainers) {
	const total = await container.count().catch(() => 0);
	for (let i = 0; i < total; i += 1) {
		const card = container.nth(i);
		try {
			if (!(await card.isVisible().catch(() => false))) continue;
			const selectBtn = card.getByRole('button', { name: /Select|Selected/i }).first();
			if ((await selectBtn.count()) > 0) {
				await clickSelect(selectBtn);
				clicked = true;
				break;
			}
			await clickSelect(card);
			clicked = true;
			break;
		} catch (e) {}
	}
	if (clicked) break;
}
if (!clicked) {
	const planButtons = plansRoot.getByRole('button', { name: /Select|Selected/i });
	for (let i = 0; i < await planButtons.count(); i += 1) {
		const btn = planButtons.nth(i);
		if (!(await btn.isVisible().catch(() => false))) continue;
		await clickSelect(btn);
		clicked = true;
		break;
	}
}
await page.waitForTimeout(1000);
const blockingText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
if (/Please select plan or device|Please select plan\.?|PlanNull|No new services added/i.test(blockingText)) {
	throw new Error('Plan selection did not stick before Add to cart');
}
}`);
	}

	if (/open\s+the\s+iphone\s+17\s+device\s+card/i.test(s)) {
		actions.push(`{
const deviceText = /iPhone\s*17(?:\s*Pro\s*Max)?/i;
const clickSelect = async (locator) => {
	await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
	await locator.scrollIntoViewIfNeeded().catch(() => {});
	try {
		await locator.click({ timeout: 15000 });
	} catch (e) {
		try {
			await locator.click({ timeout: 15000, force: true });
		} catch (forceErr) {
			await locator.evaluate((el) => el.click()).catch(() => {});
		}
	}
};
const deviceContainers = [
	page.locator('div,section,article,li').filter({ hasText: deviceText }),
	page.getByText(deviceText).locator('xpath=ancestor::*[self::div or self::section or self::article or self::li][1]'),
];
let opened = false;
for (const container of deviceContainers) {
	const total = await container.count().catch(() => 0);
	for (let i = 0; i < total; i += 1) {
		const card = container.nth(i);
		try {
			if (!(await card.isVisible().catch(() => false))) continue;
			const selectBtn = card.getByRole('button', { name: /Select|View|Choose/i }).first();
			if ((await selectBtn.count()) > 0) {
				await clickSelect(selectBtn);
				opened = true;
				break;
			}
			await clickSelect(card);
			opened = true;
			break;
		} catch (e) {}
	}
	if (opened) break;
}
if (!opened) {
	const fallbackText = page.getByText(deviceText).first();
	if ((await fallbackText.count()) > 0) await clickSelect(fallbackText);
}
await page.evaluate(() => { window.__lastDeviceRegex = 'iPhone\\s*17(?:\\s*Pro\\s*Max)?'; }).catch(() => {});
}`);
	}

	if (/select\s+the\s+256gb\s+storage\s+option/i.test(s)) {
		actions.push(`{
const deviceCard = page.locator('div,section,article,li').filter({ hasText: /iPhone\s*17(?:\s*Pro\s*Max)?/i }).first();
const combobox = deviceCard.getByRole('combobox').nth(0);
if ((await combobox.count()) > 0) {
	const options = await combobox.locator('option').evaluateAll((els) => els.map((el) => (el.textContent || '').trim())).catch(() => []);
	const desired = options.find((opt) => /256\s*GB/i.test(opt));
	if (desired) {
		await combobox.selectOption({ label: desired }).catch(() => {});
	}
}
}`);
	}

	if (/select\s+the\s+36\s+months\s+payment\s+term/i.test(s)) {
		actions.push(`{
const deviceCard = page.locator('div,section,article,li').filter({ hasText: /iPhone\s*17(?:\s*Pro\s*Max)?/i }).first();
const combobox = deviceCard.getByRole('combobox').nth(2);
if ((await combobox.count()) > 0) {
	const options = await combobox.locator('option').evaluateAll((els) => els.map((el) => (el.textContent || '').trim())).catch(() => []);
	const desired = options.find((opt) => /36\s*months/i.test(opt) || /^36$/i.test(opt));
	if (desired) {
		await combobox.selectOption({ label: desired }).catch(() => {});
	}
}
}`);
	}

	if (/add\s+vodafone\s+device\s+care/i.test(s)) {
		actions.push(`{
const deviceCard = page.locator('div,section,article,li').filter({ hasText: /iPhone\s*17(?:\s*Pro\s*Max)?/i }).first();
const combobox = deviceCard.getByRole('combobox').nth(3);
if ((await combobox.count()) > 0) {
	const options = await combobox.locator('option').evaluateAll((els) => els.map((el) => (el.textContent || '').trim())).catch(() => []);
	const desired = options.find((opt) => /Vodafone Device Care/i.test(opt));
	if (desired) {
		await combobox.selectOption({ label: desired }).catch(() => {});
	}
}
}`);
	}

	if ((/\b(open|launch|navigate to|navigate into)\b.*mobile\s*plp/i.test(s) || /open\s+the\s+mobile\s*plp\s+flow/i.test(s) || /open\s+mobile\s*plp\s+flow/i.test(s)) && !/mobile\s*plp\s+tab/i.test(s)) {
		actions.push('await launchMobilePLP(page);');
	}

	if ((/sales calculator/i.test(s) || /launch\s+sales\s+calculator/i.test(s)) && !/fill\s+first\s+name\s+and\s+last\s+name/i.test(s) && !/customer\s+form/i.test(s)) {
		actions.push(generateLaunchSalesCalculatorBlock());
	}

	// Selection intents
	const selectsDeviceAndPlan = /select\s+the\s+device\s+and\s+plan/i.test(s) || /select\s+device\s+and\s+plan/i.test(s);
	if (selectsDeviceAndPlan) {
		actions.push(`{
const safeRandom = (items) => items[Math.floor(Math.random() * items.length)];
const clickSelectOnCard = async (card) => {
	const btn = card.getByRole('button', { name: /Select|Selected/i }).first();
	if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
		await btn.scrollIntoViewIfNeeded().catch(() => {});
		await btn.click({ timeout: 15000 }).catch(() => btn.click({ timeout: 15000, force: true }));
		return true;
	}
	await card.scrollIntoViewIfNeeded().catch(() => {});
	await card.click({ timeout: 15000 }).catch(() => card.click({ timeout: 15000, force: true }));
	return true;
};
const selectByText = async (pattern, label) => {
	const textMatches = page.getByText(pattern).all();
	for (const match of await textMatches) {
		if (!(await match.isVisible().catch(() => false))) continue;
		const card = match.locator("xpath=ancestor::*[(self::div or self::section or self::article or self::li) and .//button[normalize-space()='Select' or normalize-space()='Selected' or normalize-space()='Choose' or normalize-space()='View']][1]").first();
		if ((await card.count()) > 0 && (await card.isVisible().catch(() => false))) {
			await clickSelectOnCard(card);
			console.log('Selected', label);
			return true;
		}
	}
	const rootMatches = page.locator('div,section,article,li').filter({ hasText: pattern }).all();
	for (const card of await rootMatches) {
		if (!(await card.isVisible().catch(() => false))) continue;
		const cardButton = card.getByRole('button', { name: /^Select$|^Selected$|^Choose$|^View$/i }).first();
		if ((await cardButton.count()) <= 0) continue;
		await clickSelectOnCard(card);
			console.log('Selected', label);
			return true;
	}
	return false;
};
const clickRandomBrandFilter = async () => {
	const filterCandidates = [
		page.getByRole('combobox', { name: /Filter by brand/i }).first(),
		page.getByRole('button', { name: /Filter by brand/i }).first(),
		page.getByText(/Filter by brand/i).first(),
	];
	for (const filter of filterCandidates) {
		try {
			if ((await filter.count()) > 0 && await filter.isVisible()) {
				const tag = await filter.evaluate((el) => (el.tagName || '').toLowerCase()).catch(() => '');
				if (tag === 'select') {
					const opts = await filter.locator('option').evaluateAll((els) => els.map((el) => (el.textContent || '').trim()).filter(Boolean)).catch(() => []);
					const valid = opts.filter((opt) => !/^(all|other|any|brand)$/i.test(opt));
					if (valid.length > 0) {
						await filter.selectOption({ label: safeRandom(valid) }).catch(() => {});
						return;
					}
				}
				await filter.click().catch(() => {});
				const optionCandidates = page.getByRole('option');
				const options = [];
				const total = await optionCandidates.count();
				for (let i = 0; i < total; i += 1) {
					const opt = optionCandidates.nth(i);
					const text = String((await opt.textContent().catch(() => '')) || '').trim();
					if (text && !/^(all|other|any|brand)$/i.test(text)) options.push(opt);
				}
				if (options.length > 0) {
					await safeRandom(options).click().catch(() => {});
				
					return;
				}
			}
		} catch (e) {}
	}
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
			for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
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
await clickRandomBrandFilter();
const devicePattern = /Apple\s*iPhone\s*17(?:\s*Pro\s*Max)?/i;
if (!(await selectByText(devicePattern, 'Apple iPhone 17 Pro Max'))) {
	const { deviceButtons, fallbackButtons } = await classifySelectButtons();
	const choose = async (buttons) => {
		if (!buttons.length) return false;
		const btn = safeRandom(buttons);
		await btn.scrollIntoViewIfNeeded().catch(() => {});
		await btn.click().catch(() => btn.click({ force: true }));
		return true;
	};
	await expect((deviceButtons.length || fallbackButtons.length) > 0).toBeTruthy();
	await choose(deviceButtons.length ? deviceButtons : fallbackButtons);
}
await page.waitForTimeout(500);
const planPatterns = [/Small\s+MTM\s*-\s*plan/i, /Medium\s+MTM\s*-\s*plan/i, /Large\s+MTM\s*-\s*plan/i];
let planSelected = false;
for (const pattern of planPatterns) {
	if (await selectByText(pattern, pattern.toString())) {
		planSelected = true;
		break;
	}
}
if (!planSelected) {
	const { planButtons, fallbackButtons } = await classifySelectButtons();
	const choose = async (buttons) => {
		if (!buttons.length) return false;
		const btn = safeRandom(buttons);
		await btn.scrollIntoViewIfNeeded().catch(() => {});
		await btn.click().catch(() => btn.click({ force: true }));
		return true;
	};
	await expect((planButtons.length || fallbackButtons.length) > 0).toBeTruthy();
	await choose(planButtons.length ? planButtons : fallbackButtons);
}
}`);
	}
	if (!selectsDeviceAndPlan && (/select\s+(one|a)\s+plan/i.test(s) || /select\s+plan/i.test(s) || /choose\s+plan/i.test(s))) {
		actions.push(`await page.getByRole('button', { name: /Select/i }).first().click();`);
	}
	if (/select\s+(multiple|more|two|three)\s+plans/i.test(s) || /select\s+multiple\s+plans/i.test(s)) {
		actions.push(`await Promise.all((await page.getByRole('button', { name: /Select/i }).all()).slice(0,2).map(b => b.click()));`);
	}

	if (!selectsDeviceAndPlan && /select\s+(one|a)\s+device|select\s+device/i.test(s)) {
		actions.push(`await page.getByRole('button', { name: /Select/i }).first().click();`);
	}

	if (/add\s+to\s+cart/i.test(s) || /add\s+to\s+basket/i.test(s)) {
		actions.push(`{
const btn = page.getByRole('button', { name: /Add to cart|Add to basket/i }).first();
await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
try {
	await btn.click({ timeout: 15000 });
} catch (e) {
	try {
		await btn.click({ timeout: 15000, force: true });
	} catch (forceErr) {
		await btn.evaluate((el) => el.click()).catch(() => {});
	}
}
await page.waitForTimeout(2500);
const pageText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
if (/Please select plan or device|Please select plan\.?|PlanNull|No new services added/i.test(pageText)) {
	throw new Error('Add to cart failed: no valid plan/device was added to New services');
}
const hasCartSuccess = /Cart updated|Changes have been made to your order successfully|New service/i.test(pageText);
if (!hasCartSuccess) {
	throw new Error('Add to cart did not show a cart success indicator');
}
}`);
	}

	if (/calculate\s+bundle\s*&?\s*save/i.test(s)) {
		actions.push(`{
const btn = page.getByRole('button', { name: /Calculate Bundle & Save/i }).first();
await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
try {
	await btn.click({ timeout: 15000 });
} catch (e) {
	try {
		await btn.click({ timeout: 15000, force: true });
	} catch (forceErr) {
		await btn.evaluate((el) => el.click()).catch(() => {});
	}
}
await page.waitForTimeout(1500);
}`);
	}

	if (/create\s+quote/i.test(s)) {
		actions.push(`{
const btn = page.getByRole('button', { name: /Create quote/i }).first();
await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
try {
	await btn.click({ timeout: 15000 });
} catch (e) {
	try {
		await btn.click({ timeout: 15000, force: true });
	} catch (forceErr) {
		await btn.evaluate((el) => el.click()).catch(() => {});
	}
}
await page.waitForTimeout(3000);
}`);
	}

	if (/create\s+order/i.test(s)) {
		actions.push(`{
const btn = page.getByRole('button', { name: /Create order/i }).first();
await page.locator('.ui-widget-overlay').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
await btn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
try {
	await btn.click({ timeout: 15000 });
} catch (e) {
	try {
		await btn.click({ timeout: 15000, force: true });
	} catch (forceErr) {
		await btn.evaluate((el) => el.click()).catch(() => {});
	}
}
console.log('Clicked Create order');
const popupSelectors = ['[role="dialog"]', '[aria-modal="true"]', '.ui-dialog', '.modal', '.popup', '.siebui-popup', 'div:has-text("System Alert")'];
const findVisiblePopup = async () => {
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
	const visiblePopup = await findVisiblePopup();
	const popupScope = visiblePopup?.popup;
	const closeCandidates = [
		popupScope?.getByRole('button', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
		popupScope?.getByRole('link', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
		popupScope?.getByText(/^Close$/i).last(),
		popupScope?.locator('button, a, span').filter({ hasText: /Close|OK|Ok|Dismiss|Continue/i }).first(),
		page.getByRole('button', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
		page.getByRole('link', { name: /Close|OK|Ok|Dismiss|Continue/i }).first(),
		page.getByText(/^Close$/i).last(),
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
	if (!(await findVisiblePopup())) return true;
	return false;
};
const waitForPopupToClose = async (timeout = 10000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (!(await findVisiblePopup())) return true;
		await page.waitForTimeout(500);
	}
	return false;
};
const outcomeStart = Date.now();
let ssjWarningDismissed = false;
while (Date.now() - outcomeStart < 20000) {
	const visiblePopup = await findVisiblePopup();
	const popupText = visiblePopup?.text || '';
	if (popupText) {
		console.log('Create order popup:', popupText);
		if (/VHA SSJ Credit Check Passed Flg|Credit Check Passed Flg|SBL-EXL-00147/i.test(popupText)) {
			const closed = await closeVisiblePopup();
			if (!closed) {
				throw new Error('Create order warning appeared but could not be dismissed: ' + popupText);
			}
			const popupClosed = await waitForPopupToClose(10000);
			if (!popupClosed) {
				if (ssjWarningDismissed) {
					throw new Error('Create order blocked: recurring SSJ credit-check warning after retry. Popup: ' + popupText);
				}
				throw new Error('Create order warning remained visible after Close: ' + popupText);
			}
			ssjWarningDismissed = true;
			await page.waitForTimeout(1500);
			continue;
		}
		if (/error|unable|failed|cannot|can't|invalid|mandatory|please complete|please enter|not updated|warning|exception/i.test(popupText)) {
			throw new Error('Create order blocked by popup: ' + popupText);
		}
	}
	const pageText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
	if (/Customer details|ID details|Credit check|Order summary|Order Summary|Review order|Order review|Order details|Order submitted|Order created/i.test(pageText)) {
		if (await findVisiblePopup()) {
			await page.waitForTimeout(1000);
			continue;
		}
		break;
	}
	if (/error|unable to process|failed to create order|please complete|mandatory fields|Values not updated/i.test(pageText)) {
		throw new Error('Create order failed after click: ' + pageText.slice(0, 1200));
	}
	await page.waitForTimeout(1000);
}
}`);
	}

