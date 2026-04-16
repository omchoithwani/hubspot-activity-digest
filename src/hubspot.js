'use strict';

const hubspot = require('@hubspot/api-client');
const { AsyncLocalStorage } = require('async_hooks');

// Per-async-context token store — isolates concurrent multi-tenant digest runs
// so they never read each other's HUBSPOT_ACCESS_TOKEN.
const tokenStorage = new AsyncLocalStorage();

// Cache clients by token value to avoid recreating them on every call
const clientCache = new Map();

function getClient() {
  // Prefer the token bound to the current async context (set by runWithToken),
  // fall back to the env var for single-tenant / CLI usage.
  const token = tokenStorage.getStore() || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN environment variable is required');
  if (!clientCache.has(token)) {
    clientCache.set(token, new hubspot.Client({ accessToken: token }));
  }
  return clientCache.get(token);
}

/**
 * Run an async function with a specific HubSpot token bound to the current
 * async context. All getClient() calls within fn() will use this token,
 * even if concurrent requests change process.env.HUBSPOT_ACCESS_TOKEN.
 */
function runWithToken(token, fn) {
  return tokenStorage.run(token, fn);
}

/**
 * Refresh an OAuth access token using the stored refresh token.
 * Persists the new tokens back to the database.
 */
async function refreshTenantToken(tenant) {
  const { updateTenantTokens } = require('./db');
  const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      refresh_token: tenant.hubspot_refresh_token,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${data.message || JSON.stringify(data)}`);
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await updateTenantTokens(tenant.id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tenant.hubspot_refresh_token,
    expiresAt,
  });
  console.log(`[oauth] Token refreshed for tenant ${tenant.id}`);
  return data.access_token;
}

/**
 * Run an async function with the correct token for a tenant.
 * Prefers OAuth access token (with auto-refresh) over legacy API key.
 */
async function runWithTenant(tenant, fn) {
  if (tenant.hubspot_access_token) {
    let token = tenant.hubspot_access_token;
    // Refresh proactively if within 5 minutes of expiry
    if (tenant.hubspot_token_expires_at) {
      const expiresAt = new Date(tenant.hubspot_token_expires_at).getTime();
      if (Date.now() + 5 * 60 * 1000 >= expiresAt) {
        token = await refreshTenantToken(tenant);
      }
    }
    return runWithToken(token, fn);
  }
  if (tenant.hubspot_api_key) {
    return runWithToken(tenant.hubspot_api_key, fn);
  }
  throw new Error(`No HubSpot credentials configured for tenant: ${tenant.name}`);
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for rate limit (429) errors.
 * Detects SECONDLY (per-second) vs other limits and adjusts initial wait.
 */
async function withRetry(fn, retries = 4) {
  let delay = 2000; // default start; overridden below based on policy
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status || err?.statusCode;
      if (status === 429 && attempt < retries) {
        // Honour Retry-After header if present (value is in seconds)
        const retryAfter = err?.response?.headers?.['retry-after'];
        // Treat as SECONDLY (per-second) if no Retry-After and still in short-delay range.
        // Avoids consuming the response body (which the SDK may have already read).
        const isSecondly = !retryAfter && delay < 5000;
        const waitMs = retryAfter
          ? Math.ceil(parseFloat(retryAfter)) * 1000
          : isSecondly ? 2000 : delay;
        console.warn(`Rate limited. Retrying in ${waitMs}ms... (attempt ${attempt + 1}/${retries})`);
        await sleep(waitMs);
        delay = isSecondly ? Math.min(delay * 1.5, 10000) : Math.max(delay * 2, waitMs * 2);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Fetch HubSpot account info (timezone, portalId, etc.)
 */
async function fetchAccountInfo() {
  const c = getClient();
  const data = await withRetry(() =>
    c.apiRequest({ method: 'GET', path: '/account-info/v3/details' })
  );
  return {
    timeZone: data.timeZone || 'America/New_York',
    portalId: data.portalId,
  };
}

/**
 * Get the UTC ms for midnight on a given date string (YYYY-MM-DD) in a timezone.
 * Uses the "noon trick": at noon UTC we're far from DST transitions, so the
 * offset is stable and we can back-calculate midnight accurately.
 */
function midnightUtcMs(dateStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(noonUtc);
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const min = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const sec = parseInt(parts.find((p) => p.type === 'second').value, 10);
  // At noon UTC local time is h:min:sec → subtract to reach local midnight
  return noonUtc.getTime() - (h * 3600 + min * 60 + sec) * 1000;
}

/**
 * Return { startMs, endMs } for yesterday midnight→today midnight in the given IANA timezone.
 */
function getYesterdayRange(ianaTimezone) {
  return getReportingRange(ianaTimezone, 1);
}

/**
 * Return { startMs, endMs } covering the reporting period in the given timezone.
 *
 * periodDays=1  → yesterday (12AM–midnight)
 * periodDays=7  + weekStartDay → last complete calendar week (Mon–Sun or Sun–Sat etc.)
 * periodDays=7  (no weekStartDay) → rolling last 7 days
 * periodDays=30 → rolling last 30 days
 *
 * weekStartDay: 0=Sun, 1=Mon, 2=Tue, … 6=Sat
 */
function getReportingRange(ianaTimezone, periodDays = 1, weekStartDay = null) {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: ianaTimezone }); // YYYY-MM-DD
  const [y, m, d] = todayStr.split('-').map(Number);

  // Weekly: calculate last complete calendar week using the configured start day
  if (periodDays === 7 && weekStartDay !== null) {
    const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDayStr = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTimezone, weekday: 'short',
    }).format(now);
    const currentDay = DAYS_SHORT.indexOf(currentDayStr); // 0=Sun … 6=Sat

    // How many days have elapsed since the most recent occurrence of weekStartDay?
    const daysSinceStart = (currentDay - weekStartDay + 7) % 7;

    // Current week started daysSinceStart days ago; last week started 7 days before that.
    // Use Date.UTC arithmetic on the local-date components to avoid DST shifts.
    const currentWeekStartStr = new Date(Date.UTC(y, m - 1, d - daysSinceStart, 12, 0, 0))
      .toLocaleDateString('en-CA', { timeZone: ianaTimezone });
    const lastWeekStartStr = new Date(Date.UTC(y, m - 1, d - daysSinceStart - 7, 12, 0, 0))
      .toLocaleDateString('en-CA', { timeZone: ianaTimezone });

    return {
      startMs:        midnightUtcMs(lastWeekStartStr,    ianaTimezone),
      endMs:          midnightUtcMs(currentWeekStartStr, ianaTimezone),
      startDateUtcMs: new Date(lastWeekStartStr    + 'T00:00:00Z').getTime(),
      endDateUtcMs:   new Date(currentWeekStartStr + 'T00:00:00Z').getTime(),
      startDateStr:   lastWeekStartStr,
      endDateStr:     currentWeekStartStr,
    };
  }

  // Default: rolling periodDays complete days ending at today's midnight
  const startStr = new Date(Date.UTC(y, m - 1, d - periodDays, 12, 0, 0))
    .toLocaleDateString('en-CA', { timeZone: ianaTimezone });
  return {
    startMs:        midnightUtcMs(startStr,  ianaTimezone),
    endMs:          midnightUtcMs(todayStr,  ianaTimezone),
    startDateUtcMs: new Date(startStr  + 'T00:00:00Z').getTime(),
    endDateUtcMs:   new Date(todayStr  + 'T00:00:00Z').getTime(),
    startDateStr:   startStr,
    endDateStr:     todayStr,
  };
}

/**
 * Fetch all pages of search results up to a maximum
 */
async function searchAll(searchFn, params, maxResults = 5000) {
  const results = [];
  let after = undefined;

  do {
    const searchParams = { ...params, limit: 100 };
    if (after) {
      searchParams.after = after;
      // Pause between pages to stay within HubSpot's per-second search limit
      await sleep(400);
    }

    const response = await withRetry(() => searchFn(searchParams));
    if (response.results) {
      results.push(...response.results);
    }
    after = response.paging?.next?.after;
  } while (after && results.length < maxResults);

  return results;
}

/**
 * Fetch all HubSpot owners and return a map of id -> { name, email }
 */
async function fetchOwners() {
  try {
    const c = getClient();
    const response = await withRetry(() => c.crm.owners.ownersApi.getPage(undefined, undefined, 500));
    const ownerMap = {};
    for (const owner of response.results || []) {
      ownerMap[owner.id] = {
        name: `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.email || `Owner ${owner.id}`,
        email: owner.email,
      };
    }
    return ownerMap;
  } catch (err) {
    console.error('Failed to fetch owners:', err.message);
    return {};
  }
}

/**
 * Fetch pipeline stage names for deals
 */
async function fetchDealStages() {
  try {
    const c = getClient();
    const pipelines = await withRetry(() => c.crm.pipelines.pipelinesApi.getAll('deals'));
    const stageMap = {};
    for (const pipeline of pipelines.results || []) {
      for (const stage of pipeline.stages || []) {
        stageMap[stage.id] = { label: stage.label, pipeline: pipeline.label };
      }
    }
    return stageMap;
  } catch (err) {
    console.error('Failed to fetch deal stages:', err.message);
    return {};
  }
}

/**
 * Fetch deals created in the last 24 hours
 */
async function fetchDealsCreated({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.deals.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'pipeline', 'closedate', 'hs_deal_stage_probability', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }
    );
  } catch (err) {
    console.error('Failed to fetch deals created:', err.message);
    throw err;
  }
}

/**
 * Fetch deals with stage changes in the last 24 hours
 * Uses the property history API to detect FROM → TO stage transitions
 */
async function fetchDealStageChanges({ startMs, endMs }) {
  try {
    const c = getClient();

    // Fetch deals modified in the yesterday window
    const modifiedDeals = await searchAll(
      (params) => c.crm.deals.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_lastmodifieddate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['dealname', 'dealstage', 'hubspot_owner_id', 'pipeline'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      }
    );

    if (modifiedDeals.length === 0) return [];

    // For each deal, fetch dealstage property history
    const stageChanges = [];
    const batchSize = 10;

    for (let i = 0; i < modifiedDeals.length; i += batchSize) {
      const batch = modifiedDeals.slice(i, i + batchSize);
      const historyPromises = batch.map(async (deal) => {
        try {
          const raw = await withRetry(() =>
            c.apiRequest({
              method: 'GET',
              path: `/crm/v3/objects/deals/${deal.id}`,
              qs: { propertiesWithHistory: 'dealstage' },
            })
          );
          const history = raw?.json ? await raw.json() : raw;

          const stageHistory = history?.propertiesWithHistory?.dealstage || [];

          // All changes that occurred within the window (newest-first)
          const windowChanges = stageHistory.filter((entry) => {
            const ts = new Date(entry.timestamp).getTime();
            return ts >= startMs && ts < endMs;
          });

          if (windowChanges.length === 0) return;

          // toStage = deal's current stage (already fetched in search)
          const toStage = deal.properties.dealstage;

          // fromStage = stage just before the oldest change in the window
          const oldestChange = windowChanges[windowChanges.length - 1];
          const oldestIdx = stageHistory.indexOf(oldestChange);
          const fromStage = stageHistory[oldestIdx + 1]?.value;

          if (fromStage && fromStage !== toStage) {
            stageChanges.push({
              id: deal.id,
              dealname: deal.properties.dealname,
              hubspot_owner_id: deal.properties.hubspot_owner_id,
              pipeline: deal.properties.pipeline,
              fromStage,
              toStage,
              changedAt: windowChanges[0].timestamp,
            });
          }
        } catch (err) {
          console.warn(`Failed to fetch history for deal ${deal.id}:`, err.message);
        }
      });

      await Promise.all(historyPromises);
      if (i + batchSize < modifiedDeals.length) await sleep(200);
    }

    return stageChanges;
  } catch (err) {
    console.error('Failed to fetch deal stage changes:', err.message);
    throw err;
  }
}

/**
 * Fetch tasks completed in the last 24 hours
 */
async function fetchTasksCompleted({ startMs, endMs, startDateUtcMs, endDateUtcMs, startDateStr, endDateStr }) {
  const completionStart = startDateUtcMs ?? startMs;
  const completionEnd   = endDateUtcMs   ?? endMs;
  // Widen search window by 1 day on each side to catch UTC-offset edge cases,
  // then post-filter precisely using date strings.
  const searchStart = completionStart - 86400000;
  const searchEnd   = completionEnd   + 86400000;

  try {
    const c = getClient();

    // Search 1: tasks where hs_task_completion_date falls in the window.
    // (This property stores UTC midnight for the completion date.)
    const byCompletionDate = await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('tasks', params),
      {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_task_status',          operator: 'EQ',  value: 'COMPLETED' },
            { propertyName: 'hs_task_completion_date', operator: 'GTE', value: String(searchStart) },
            { propertyName: 'hs_task_completion_date', operator: 'LT',  value: String(searchEnd) },
          ],
        }],
        properties: ['hs_task_subject', 'hs_task_type', 'hubspot_owner_id', 'hs_task_body', 'hs_timestamp', 'hs_task_completion_date'],
        sorts: [{ propertyName: 'hs_task_completion_date', direction: 'DESCENDING' }],
      }
    );

    // Search 2: tasks modified in the window that are completed.
    // Catches tasks whose hs_task_completion_date is missing or set differently.
    const byLastModified = await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('tasks', params),
      {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_task_status',       operator: 'EQ',  value: 'COMPLETED' },
            { propertyName: 'hs_lastmodifieddate',  operator: 'GTE', value: String(startMs) },
            { propertyName: 'hs_lastmodifieddate',  operator: 'LT',  value: String(endMs) },
          ],
        }],
        properties: ['hs_task_subject', 'hs_task_type', 'hubspot_owner_id', 'hs_task_body', 'hs_timestamp', 'hs_task_completion_date'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      }
    );

    // Merge, deduplicate, then post-filter precisely.
    // hs_task_completion_date is returned as epoch-ms string (e.g. "1742774400000"),
    // NOT as an ISO date — new Date("1742774400000") is NaN in V8, so we must
    // parse it with Number() first. We then compare as UTC date strings to avoid
    // any timezone-offset mismatch.
    const seen = new Set();
    return [...byCompletionDate, ...byLastModified].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      const cd = t.properties?.hs_task_completion_date;
      if (cd) {
        // Handle both numeric-string ("1742774400000") and ISO-string ("2026-03-24") formats
        const cdMs = /^\d+$/.test(cd) ? Number(cd) : new Date(cd).getTime();
        if (isNaN(cdMs)) return false;
        if (startDateStr && endDateStr) {
          // Compare as UTC date strings: "YYYY-MM-DD" >= startDateStr && < endDateStr
          const cdDateStr = new Date(cdMs).toISOString().split('T')[0];
          return cdDateStr >= startDateStr && cdDateStr < endDateStr;
        }
        return cdMs >= completionStart && cdMs < completionEnd;
      }
      return true; // no completion date — include it (came from lastModified search)
    });
  } catch (err) {
    console.error('Failed to fetch tasks:', err.message);
    throw err;
  }
}

/**
 * Fetch call disposition options → { guidValue: label } map.
 * Used to convert hs_call_disposition GUIDs to readable outcomes in charts.
 */
async function fetchCallDispositions() {
  try {
    const c = getClient();
    const raw = await withRetry(() =>
      c.apiRequest({ method: 'GET', path: '/crm/v3/properties/calls/hs_call_disposition' })
    );
    // apiRequest may return a pre-parsed object or a fetch Response depending on SDK version
    const data = (raw && typeof raw.json === 'function') ? await raw.json() : raw;
    const map = {};
    for (const opt of (data?.options || [])) {
      if (opt.value && opt.label) map[opt.value] = opt.label;
    }
    return map;
  } catch (err) {
    console.warn('Could not fetch call dispositions:', err.message);
    return {};
  }
}

/**
 * Fetch calls logged in the last 24 hours
 */
async function fetchCallsLogged({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('calls', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['hs_call_title', 'hs_call_direction', 'hs_call_duration', 'hs_call_disposition', 'hubspot_owner_id', 'hs_call_body', 'hs_createdate'],
        sorts: ['-hs_createdate'],
      }
    );
  } catch (err) {
    console.error('Failed to fetch calls:', err.message);
    throw err;
  }
}

/**
 * Fetch emails sent (1:1 sales emails) in the last 24 hours
 */
async function fetchEmailsSent({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('emails', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['hs_email_subject', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id', 'hs_email_to_email'],
        sorts: ['-hs_createdate'],
      }
    );
  } catch (err) {
    console.error('Failed to fetch emails:', err.message);
    throw err;
  }
}

/**
 * Fetch meetings booked in the last 24 hours
 */
async function fetchMeetingsBooked({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('meetings', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hubspot_owner_id', 'hs_meeting_body'],
        sorts: ['-hs_createdate'],
      }
    );
  } catch (err) {
    console.error('Failed to fetch meetings:', err.message);
    throw err;
  }
}

/**
 * Fetch notes added in the last 24 hours
 */
async function fetchNotesAdded({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('notes', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['hs_note_body', 'hubspot_owner_id', 'hs_timestamp'],
        sorts: ['-hs_createdate'],
      }
    );
  } catch (err) {
    console.error('Failed to fetch notes:', err.message);
    throw err;
  }
}

/**
 * Fetch contacts created in the last 24 hours
 */
async function fetchContactsCreated({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.contacts.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['firstname', 'lastname', 'email', 'company', 'hubspot_owner_id', 'jobtitle', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }
    );
  } catch (err) {
    console.error('Failed to fetch contacts:', err.message);
    throw err;
  }
}

/**
 * Fetch companies created in the last 24 hours
 */
async function fetchCompaniesCreated({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.companies.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'createdate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['name', 'domain', 'industry', 'hubspot_owner_id', 'city', 'country', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }
    );
  } catch (err) {
    console.error('Failed to fetch companies:', err.message);
    throw err;
  }
}

/**
 * Fetch submissions for a single form, filtered to the given time window.
 * Returns newest-first from the API so we stop early once we pass startMs.
 */
async function fetchSubmissionsForForm(formId, startMs, endMs) {
  const c = getClient();
  const submissions = [];
  let after = undefined;
  let firstPage = true;

  do {
    const qs = { limit: 50 };
    if (after) qs.after = String(after);

    const resp = await withRetry(async () => {
      const r = await c.apiRequest({ method: 'GET', path: `/form-integrations/v1/submissions/forms/${formId}`, qs });
      return r?.json ? r.json() : r;
    });

    const page = resp.results || [];

    if (firstPage) {
      if (page.length > 0) {
        console.log(`[forms] first submission sample for form ${formId}:`, JSON.stringify(page[0]).slice(0, 300));
      } else {
        console.log(`[forms] form ${formId}: first page is empty (no submissions at all)`);
      }
      firstPage = false;
    }

    let hitOldData = false;

    for (const sub of page) {
      // submittedAt is documented as milliseconds, but guard against seconds
      let ts = sub.submittedAt;
      if (ts == null) {
        console.warn(`[forms] submission missing submittedAt — raw keys: ${Object.keys(sub).join(', ')}`);
        continue;
      }
      // If the value looks like seconds (< year 2000 in ms), convert it
      if (ts < 946684800000) ts = ts * 1000;

      if (ts < startMs) { hitOldData = true; break; }
      if (ts >= startMs && ts < endMs) submissions.push({ ...sub, submittedAt: ts });
    }

    if (hitOldData) break;
    after = resp.paging?.next?.after;
  } while (after);

  return submissions;
}

/**
 * Fetch all form submissions from yesterday, grouped by form.
 * Returns an array of { formId, formName, count, submissions[] }.
 */
async function fetchFormsSubmitted({ startMs, endMs }) {
  try {
    const c = getClient();

    // List all forms in the portal
    const formsResp = await withRetry(async () => {
      const r = await c.apiRequest({ method: 'GET', path: '/marketing/v3/forms', qs: { limit: 200 } });
      return r?.json ? r.json() : r;
    });
    const forms = formsResp?.results || [];
    console.log(`[forms] found ${forms.length} forms in portal`);

    const results = [];
    for (const form of forms) {
      const submissions = await fetchSubmissionsForForm(form.id, startMs, endMs);
      console.log(`[forms] ${form.name || form.id}: ${submissions.length} submissions in window`);
      if (submissions.length > 0) {
        results.push({ formId: form.id, formName: form.name || form.id, count: submissions.length, submissions });
      }
      // Small pause between forms to stay well within rate limits
      await sleep(150);
    }

    return results;
  } catch (err) {
    console.error('Failed to fetch form submissions:', err.message);
    throw err;
  }
}

/**
 * Fetch contacts created from paid ads in the given window.
 * Identifies ad-sourced contacts via hs_latest_source = PAID_SEARCH | PAID_SOCIAL.
 * Returns contacts with ad attribution properties attached.
 */
async function fetchAdLeads({ startMs, endMs }) {
  try {
    const c = getClient();

    const dateFilters = [
      { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
      { propertyName: 'createdate', operator: 'LTE', value: String(endMs) },
    ];

    // OR across latest-touch and original-touch for both paid channels,
    // so a lead isn't missed if they had a subsequent non-ad interaction.
    const paidSources = ['PAID_SEARCH', 'PAID_SOCIAL'];
    const filterGroups = [
      ...paidSources.map((src) => ({
        filters: [...dateFilters, { propertyName: 'hs_latest_source', operator: 'EQ', value: src }],
      })),
      ...paidSources.map((src) => ({
        filters: [...dateFilters, { propertyName: 'hs_analytics_source', operator: 'EQ', value: src }],
      })),
    ];

    const results = await searchAll(
      (params) => c.crm.contacts.searchApi.doSearch(params),
      {
        filterGroups,
        properties: [
          'firstname', 'lastname', 'email', 'company', 'jobtitle', 'createdate',
          'hs_latest_source',
          'hs_latest_source_data_1',    // platform (latest touch), e.g. "google"
          'hs_latest_source_data_2',    // campaign (latest touch)
          'hs_analytics_source',
          'hs_analytics_source_data_1', // platform (first touch)
          'hs_analytics_source_data_2', // campaign (first touch)
        ],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }
    );

    // De-duplicate in case a contact matched multiple filter groups
    const seen = new Set();
    return results.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  } catch (err) {
    console.error('Failed to fetch ad leads:', err.message);
    throw err;
  }
}

/**
 * Given an array of note IDs, return a map of noteId → { contacts: [name…], deals: [name…] }
 * using the CRM v4 batch associations API.
 */
async function fetchNoteAssociations(noteIds) {
  if (noteIds.length === 0) return {};
  const c = getClient();
  const assocMap = {};
  noteIds.forEach((id) => { assocMap[id] = { contacts: [], deals: [] }; });

  async function batchAssoc(toType) {
    const resp = await withRetry(() =>
      c.apiRequest({
        method: 'POST',
        path: `/crm/v3/associations/notes/${toType}/batch/read`,
        body: { inputs: noteIds.map((id) => ({ id })) },
      })
    );
    const map = {};
    for (const r of resp.results || []) {
      map[String(r.from.id)] = (r.to || []).map((t) => String(t.id));
    }
    return map;
  }

  // Contacts
  try {
    const noteToContactIds = await batchAssoc('contacts');
    const allContactIds = [...new Set(Object.values(noteToContactIds).flat())];
    if (allContactIds.length > 0) {
      const batch = await withRetry(() =>
        c.crm.contacts.batchApi.read({
          inputs: allContactIds.map((id) => ({ id })),
          properties: ['firstname', 'lastname', 'email'],
          propertiesWithHistory: [],
        })
      );
      const nameMap = {};
      for (const ct of batch.results || []) {
        nameMap[ct.id] = [ct.properties?.firstname, ct.properties?.lastname].filter(Boolean).join(' ') || ct.properties?.email || ct.id;
      }
      for (const [noteId, cIds] of Object.entries(noteToContactIds)) {
        assocMap[noteId].contacts = cIds.map((id) => nameMap[id]).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('Failed to fetch note→contact associations:', err.message);
  }

  // Deals
  try {
    const noteToDealIds = await batchAssoc('deals');
    const allDealIds = [...new Set(Object.values(noteToDealIds).flat())];
    if (allDealIds.length > 0) {
      const batch = await withRetry(() =>
        c.crm.deals.batchApi.read({
          inputs: allDealIds.map((id) => ({ id })),
          properties: ['dealname'],
          propertiesWithHistory: [],
        })
      );
      const nameMap = {};
      for (const dl of batch.results || []) {
        nameMap[dl.id] = dl.properties?.dealname || dl.id;
      }
      for (const [noteId, dIds] of Object.entries(noteToDealIds)) {
        assocMap[noteId].deals = dIds.map((id) => nameMap[id]).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('Failed to fetch note→deal associations:', err.message);
  }

  return assocMap;
}

module.exports = {
  runWithToken,
  runWithTenant,
  refreshTenantToken,
  fetchCallDispositions,
  fetchOwners,
  fetchDealStages,
  fetchDealsCreated,
  fetchDealStageChanges,
  fetchTasksCompleted,
  fetchCallsLogged,
  fetchEmailsSent,
  fetchMeetingsBooked,
  fetchNotesAdded,
  fetchNoteAssociations,
  fetchContactsCreated,
  fetchCompaniesCreated,
  fetchAccountInfo,
  getYesterdayRange,
  getReportingRange,
  fetchFormsSubmitted,
  fetchAdLeads,
};
