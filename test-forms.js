'use strict';

require('dotenv').config();
const hubspot = require('@hubspot/api-client');

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) { console.error('Missing HUBSPOT_ACCESS_TOKEN'); process.exit(1); }

const c = new hubspot.Client({ accessToken: token });

// Yesterday midnight → today midnight (UTC, simple version for testing)
const now = new Date();
const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const yesterdayMidnight = new Date(todayMidnight.getTime() - 86400000);
const startMs = yesterdayMidnight.getTime();
const endMs = todayMidnight.getTime();

console.log(`Window: ${yesterdayMidnight.toISOString()} → ${todayMidnight.toISOString()}\n`);

async function run() {
  // 1. List all forms — try v3 first, fall back to v2
  let forms = [];
  try {
    const formsResp = await c.apiRequest({ method: 'GET', path: '/marketing/v3/forms', qs: { limit: 200 } });
    console.log('v3 raw response:', JSON.stringify(formsResp).slice(0, 500));
    forms = formsResp.results || [];
    console.log(`v3 forms API: ${forms.length} form(s)`);
  } catch (e) {
    console.log(`v3 forms API failed: ${e.message}`, e.body || '');
  }

  if (forms.length === 0) {
    try {
      const formsResp2 = await c.apiRequest({ method: 'GET', path: '/forms/v2/forms' });
      console.log('v2 raw response (first 500):', JSON.stringify(formsResp2).slice(0, 500));
      forms = Array.isArray(formsResp2) ? formsResp2 : (formsResp2.results || []);
      console.log(`v2 forms API: ${forms.length} form(s)`);
      forms = forms.map(f => ({ ...f, id: f.id || f.guid }));
    } catch (e) {
      console.log(`v2 forms API failed: ${e.message}`, e.body || '');
    }
  }

  console.log();

  for (const form of forms) {
    // 2. Fetch first page of submissions for each form
    const resp = await c.apiRequest({
      method: 'GET',
      path: `/form-integrations/v1/submissions/forms/${form.id}`,
      qs: { limit: 10 },
    });

    const page = resp.results || [];
    console.log(`Form: "${form.name}" (${form.id})`);
    console.log(`  Total submissions in first page: ${page.length}`);

    if (page.length > 0) {
      const first = page[0];
      console.log(`  Raw keys: ${Object.keys(first).join(', ')}`);
      console.log(`  submittedAt: ${first.submittedAt} (type: ${typeof first.submittedAt})`);
      if (first.submittedAt) {
        const d = new Date(first.submittedAt);
        console.log(`  submittedAt as date: ${d.toISOString()}`);
        console.log(`  In window? ${first.submittedAt >= startMs && first.submittedAt < endMs}`);
      }

      // Count how many fall in the window
      const inWindow = page.filter(s => s.submittedAt >= startMs && s.submittedAt < endMs);
      console.log(`  In yesterday's window (first page): ${inWindow.length}`);
    }
    console.log();
  }
}

run().catch(console.error);
