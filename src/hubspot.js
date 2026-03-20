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
 * Get timestamp for 24 hours ago (in milliseconds)
 */
function getYesterdayTimestamp() {
  return Date.now() - 24 * 60 * 60 * 1000;
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
async function fetchDealsCreated(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.deals.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'pipeline', 'closedate', 'hs_deal_stage_probability'],
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
async function fetchDealStageChanges(yesterdayTs) {
  try {
    const c = getClient();

    // Fetch deals modified in last 24h
    const modifiedDeals = await searchAll(
      (params) => c.crm.deals.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(yesterdayTs) },
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
            return ts >= yesterdayTs;
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
async function fetchTasksCompleted(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('tasks', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_task_status', operator: 'EQ', value: 'COMPLETED' },
              { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(yesterdayTs) },
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
async function fetchCallsLogged(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('calls', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['hs_call_title', 'hs_call_direction', 'hs_call_duration', 'hs_call_disposition', 'hubspot_owner_id', 'hs_call_body'],
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
async function fetchEmailsSent(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('emails', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['hs_email_subject', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id', 'hs_email_html'],
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
async function fetchMeetingsBooked(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('meetings', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hubspot_owner_id', 'hs_meeting_body'],
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
async function fetchNotesAdded(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.objects.searchApi.doSearch('notes', params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['hs_note_body', 'hubspot_owner_id', 'hs_timestamp'],
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
async function fetchContactsCreated(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.contacts.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['firstname', 'lastname', 'email', 'company', 'hubspot_owner_id', 'jobtitle'],
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
async function fetchCompaniesCreated(yesterdayTs) {
  try {
    const c = getClient();
    return await searchAll(
      (params) => c.crm.companies.searchApi.doSearch(params),
      {
        filterGroups: [
          {
            filters: [
              { propertyName: 'createdate', operator: 'GTE', value: String(yesterdayTs) },
            ],
          },
        ],
        properties: ['name', 'domain', 'industry', 'hubspot_owner_id', 'city', 'country'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      }
    );
  } catch (err) {
    console.error('Failed to fetch companies:', err.message);
    throw err;
  }
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
  fetchContactsCreated,
  fetchCompaniesCreated,
  sendEmail,
  getYesterdayTimestamp,
};
