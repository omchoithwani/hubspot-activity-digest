'use strict';

const hubspot = require('@hubspot/api-client');

let client;

function getClient() {
  if (!client) {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) {
      throw new Error('HUBSPOT_ACCESS_TOKEN environment variable is required');
    }
    client = new hubspot.Client({ accessToken: token });
  }
  return client;
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff for rate limit (429) errors
 */
async function withRetry(fn, retries = 4) {
  let delay = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status || err?.statusCode;
      if (status === 429 && attempt < retries) {
        console.warn(`Rate limited. Retrying in ${delay}ms... (attempt ${attempt + 1}/${retries})`);
        await sleep(delay);
        delay *= 2;
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
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: ianaTimezone }); // YYYY-MM-DD
  const [y, m, d] = todayStr.split('-').map(Number);
  const yesterdayStr = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0))
    .toLocaleDateString('en-CA', { timeZone: ianaTimezone });
  return {
    startMs: midnightUtcMs(yesterdayStr, ianaTimezone),
    endMs: midnightUtcMs(todayStr, ianaTimezone),
  };
}

/**
 * Fetch all pages of search results up to a maximum
 */
async function searchAll(searchFn, params, maxResults = 500) {
  const results = [];
  let after = undefined;

  do {
    const searchParams = { ...params, limit: 100 };
    if (after) searchParams.after = after;

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
          const history = await withRetry(() =>
            c.crm.deals.propertiesApi.getAll('deals', false)
              .then(() =>
                c.apiRequest({
                  method: 'GET',
                  path: `/crm/v3/objects/deals/${deal.id}`,
                  qs: { propertiesWithHistory: 'dealstage' },
                })
              )
          );

          const stageHistory = history?.propertiesWithHistory?.dealstage || [];
          const recentChanges = stageHistory.filter((entry) => {
            const ts = new Date(entry.timestamp).getTime();
            return ts >= startMs && ts < endMs;
          });

          if (recentChanges.length >= 2) {
            // Most recent is index 0, previous is index 1
            const toStage = recentChanges[0].value;
            const fromStage = recentChanges[1].value;
            if (fromStage !== toStage) {
              stageChanges.push({
                id: deal.id,
                dealname: deal.properties.dealname,
                hubspot_owner_id: deal.properties.hubspot_owner_id,
                pipeline: deal.properties.pipeline,
                fromStage,
                toStage,
                changedAt: recentChanges[0].timestamp,
              });
            }
          } else if (recentChanges.length === 1 && stageHistory.length >= 2) {
            // Only one recent change; compare to previous entry
            const toStage = recentChanges[0].value;
            const fromStage = stageHistory[1].value;
            if (fromStage !== toStage) {
              stageChanges.push({
                id: deal.id,
                dealname: deal.properties.dealname,
                hubspot_owner_id: deal.properties.hubspot_owner_id,
                pipeline: deal.properties.pipeline,
                fromStage,
                toStage,
                changedAt: recentChanges[0].timestamp,
              });
            }
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
async function fetchTasksCompleted({ startMs, endMs }) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('tasks', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_task_status', operator: 'EQ', value: 'COMPLETED' },
              { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(startMs) },
              { propertyName: 'hs_lastmodifieddate', operator: 'LTE', value: String(endMs) },
            ],
          },
        ],
        properties: ['hs_task_subject', 'hs_task_type', 'hubspot_owner_id', 'hs_task_body', 'hs_timestamp'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      }
    );
  } catch (err) {
    console.error('Failed to fetch tasks:', err.message);
    throw err;
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

    const resp = await withRetry(() =>
      c.apiRequest({ method: 'GET', path: `/form-integrations/v1/submissions/forms/${formId}`, qs })
    );

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
    const formsResp = await withRetry(() =>
      c.apiRequest({ method: 'GET', path: '/marketing/v3/forms', qs: { limit: 200 } })
    );
    const forms = formsResp.results || [];
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

/**
 * Send email via HubSpot Single Send API (transactional)
 */
async function sendEmail({ toEmails, subject, htmlBody }) {
  const c = getClient();

  // HubSpot transactional email requires a valid from address configured in HubSpot
  // We use the Marketing Email API for single sends
  const fromEmail = process.env.FROM_EMAIL || 'digest@aerorev.com';
  const fromName = process.env.FROM_NAME || 'AeroRev HubSpot Digest';

  // Use HubSpot's Single Send API (requires transactional email access)
  for (const toEmail of toEmails) {
    await withRetry(() =>
      c.apiRequest({
        method: 'POST',
        path: '/marketing/v3/transactional/single-email/send',
        body: {
          emailId: 0, // 0 = custom HTML email
          message: {
            to: toEmail,
            from: fromEmail,
            replyTo: fromEmail,
            cc: [],
            bcc: [],
            sendId: `digest-${Date.now()}-${toEmail.replace(/[^a-z0-9]/gi, '')}`,
          },
          customProperties: {},
          contactProperties: {},
          content: {
            subject,
            html: htmlBody,
          },
        },
      })
    );
    console.log(`Email sent to ${toEmail}`);
  }
}

module.exports = {
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
  sendEmail,
  fetchAccountInfo,
  getYesterdayRange,
  fetchFormsSubmitted,
};
