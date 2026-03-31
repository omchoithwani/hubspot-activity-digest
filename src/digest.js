'use strict';

require('dotenv').config();

const {
  runWithToken,
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
} = require('./hubspot');

const { sendEmail } = require('./mailer');

const { generateEmailHtml, generateSubject } = require('./emailTemplate');

// Shared state for the health check server
const state = {
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
};

/**
 * Format a Date object as a readable string in the given IANA timezone.
 */
function formatDate(date, timezone) {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * Attempt to fetch one activity type. On failure, log error and return empty array.
 * Pushes error description to the errors array.
 */
async function safelyFetch(name, fetchFn, errors) {
  try {
    const result = await fetchFn();
    console.log(`  ✓ ${name}: ${result.length} records`);
    return result;
  } catch (err) {
    const msg = `${name}: ${err.message}`;
    console.error(`  ✗ ${msg}`);
    errors.push(msg);
    return [];
  }
}

/**
 * Core digest generation function
 */
async function generateDigest(options = {}) {
  const { isTest = false, skipEmail = false, hubspotApiKey, recipients: recipientOverride, previewUrl } = options;

  // For multi-tenant: run the whole digest inside an async context that binds
  // this tenant's API key, so concurrent runs never clobber each other.
  if (hubspotApiKey) {
    return runWithToken(hubspotApiKey, () => _generateDigest(options));
  }
  return _generateDigest(options);
}

async function _generateDigest(options = {}) {
  const { isTest = false, skipEmail = false, hubspotApiKey, recipients: recipientOverride, previewUrl, reportPeriodDays = 1, tenantId } = options;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`HubSpot Activity Digest — ${new Date().toISOString()}`);
  console.log(`Mode: ${isTest ? 'TEST' : 'PRODUCTION'}`);
  console.log('='.repeat(60));

  const now = new Date();

  // Fetch account timezone before anything else and cache it on the tenant record
  // so the scheduler always uses the same timezone as HubSpot.
  let accountTimezone = 'America/New_York';
  try {
    const info = await fetchAccountInfo();
    accountTimezone = info.timeZone;
    console.log(`Account timezone: ${accountTimezone}`);
    if (tenantId) {
      const { updateTenantTimezone } = require('./db');
      updateTenantTimezone(tenantId, accountTimezone).catch(() => {});
    }
  } catch (err) {
    console.warn(`Could not fetch account timezone, defaulting to ${accountTimezone}:`, err.message);
  }

  const range = getReportingRange(accountTimezone, reportPeriodDays);
  const dateRange = `${formatDate(new Date(range.startMs), accountTimezone)} → ${formatDate(new Date(range.endMs), accountTimezone)}`;
  console.log(`\nFetching activities for: ${dateRange}`);

  const errors = [];

  // Fetch owners and stage map first (needed for rendering)
  console.log('\nFetching metadata...');
  const [ownerMap, stageMap] = await Promise.all([
    safelyFetch('Owners', fetchOwners, errors),
    safelyFetch('Deal Stages', fetchDealStages, errors),
  ]);

  // Fetch activity types one at a time with a 500ms gap between each call.
  // HubSpot's Search API allows 4 req/s; each searchAll may paginate internally,
  // so running even two in parallel can trigger 429s.
  console.log('\nFetching activities...');
  const gap = () => new Promise((r) => setTimeout(r, 500));

  const dealsCreated = await safelyFetch('Deals Created', () => fetchDealsCreated(range), errors);
  await gap();
  const dealStageChanges = await safelyFetch('Deal Stage Changes', () => fetchDealStageChanges(range), errors);
  await gap();
  const tasksCompleted = await safelyFetch('Tasks Completed', () => fetchTasksCompleted(range), errors);
  await gap();
  const callsLogged = await safelyFetch('Calls Logged', () => fetchCallsLogged(range), errors);
  await gap();
  const emailsSent = await safelyFetch('Emails Sent', () => fetchEmailsSent(range), errors);
  await gap();
  const meetingsBooked = await safelyFetch('Meetings Booked', () => fetchMeetingsBooked(range), errors);
  await gap();
  const notesAdded = await safelyFetch('Notes Added', () => fetchNotesAdded(range), errors);
  await gap();
  const contactsCreated = await safelyFetch('Contacts Created', () => fetchContactsCreated(range), errors);
  await gap();
  const companiesCreated = await safelyFetch('Companies Created', () => fetchCompaniesCreated(range), errors);

  // Form submissions are sequential (one request per form), fetch after the parallel batch
  const formsSubmitted = await safelyFetch('Form Submissions', () => fetchFormsSubmitted(range), errors);

  // Ad leads — contacts attributed to paid ads (PAID_SEARCH / PAID_SOCIAL)
  const adLeads = await safelyFetch('Ad Leads', () => fetchAdLeads(range), errors);

  // Note associations (contact + deal names) — sequential after notes are known
  let noteAssociations = {};
  if (notesAdded.length > 0) {
    try {
      noteAssociations = await fetchNoteAssociations(notesAdded.map((n) => n.id));
      console.log(`  ✓ Note Associations: fetched for ${notesAdded.length} notes`);
    } catch (err) {
      console.warn(`  ✗ Note Associations: ${err.message}`);
      errors.push(`Note Associations: ${err.message}`);
    }
  }

  const data = {
    dealsCreated,
    dealStageChanges,
    tasksCompleted,
    callsLogged,
    emailsSent,
    meetingsBooked,
    notesAdded,
    contactsCreated,
    companiesCreated,
    formsSubmitted,
    noteAssociations,
    adLeads,
  };

  const totalFormSubmissions = formsSubmitted.reduce((s, f) => s + f.count, 0);
  const totalActivities =
    dealsCreated.length + dealStageChanges.length + tasksCompleted.length +
    callsLogged.length + emailsSent.length + meetingsBooked.length +
    notesAdded.length + contactsCreated.length + companiesCreated.length +
    totalFormSubmissions;

  console.log(`\nTotal activities: ${totalActivities}`);
  if (errors.length > 0) {
    console.log(`Errors encountered: ${errors.length}`);
  }

  // Generate HTML email
  console.log('\nGenerating email template...');
  const htmlBody = generateEmailHtml({
    dateRange,
    data,
    ownerMap: Array.isArray(ownerMap) ? {} : ownerMap,
    stageMap: Array.isArray(stageMap) ? {} : stageMap,
    errors,
    previewUrl,
    showAll: skipEmail, // preview renders all rows; email caps at VIEW_MORE_LIMIT
  });

  const subject = generateSubject(formatDate(now, accountTimezone).split(',')[0], totalActivities);

  // If preview mode, skip email and return HTML directly
  if (skipEmail) {
    console.log(`\n👁  Preview mode — skipping email send.`);
    console.log('='.repeat(60) + '\n');
    return { success: true, totalActivities, errors, htmlBody };
  }

  // Determine recipients (priority: override > test env > env var)
  let recipients;
  if (recipientOverride) {
    recipients = Array.isArray(recipientOverride)
      ? recipientOverride
      : recipientOverride.split(',').map((e) => e.trim()).filter(Boolean);
    console.log(`\nSending to ${recipients.length} recipient(s): ${recipients.join(', ')}`);
  } else if (isTest) {
    const testEmail = process.env.TEST_RECIPIENT_EMAIL || process.env.RECIPIENT_EMAILS;
    if (!testEmail) {
      throw new Error('TEST_RECIPIENT_EMAIL or RECIPIENT_EMAILS must be set for test mode');
    }
    recipients = testEmail.split(',').map((e) => e.trim()).filter(Boolean);
    console.log(`\nTest mode: sending to ${recipients.join(', ')}`);
  } else {
    const recipientEnv = process.env.RECIPIENT_EMAILS;
    if (!recipientEnv) {
      throw new Error('RECIPIENT_EMAILS environment variable is required');
    }
    recipients = recipientEnv.split(',').map((e) => e.trim()).filter(Boolean);
    console.log(`\nSending to ${recipients.length} recipient(s): ${recipients.join(', ')}`);
  }

  // Send email
  console.log('Sending email...');
  await sendEmail({ toEmails: recipients, subject, htmlBody });

  console.log(`\n✅ Digest sent successfully!`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Recipients: ${recipients.join(', ')}`);
  console.log(`   Total activities: ${totalActivities}`);
  console.log('='.repeat(60) + '\n');

  return { success: true, totalActivities, errors, htmlBody };
}

/**
 * Update shared state (used by health check server)
 */
async function runDigest(options = {}) {
  state.lastRunAt = new Date().toISOString();
  try {
    const result = await generateDigest(options);
    state.lastRunStatus = 'success';
    state.lastRunError = null;
    return result;
  } catch (err) {
    state.lastRunStatus = 'error';
    state.lastRunError = err.message;
    console.error('\n❌ Digest failed:', err.message);
    console.error(err.stack);
    throw err;
  }
}

/**
 * Returns true if the tenant's scheduled digest should run at `now`.
 * The cron fires every hour; this checks whether the current hour (in
 * the tenant's timezone) matches the configured hour, and for weekly
 * digests also checks the day of week.
 */
function shouldRunTenant(tenant, now = new Date()) {
  const tz = tenant.digest_timezone || 'America/New_York';
  const targetHour = Number(tenant.digest_hour ?? 7);
  const freq = tenant.digest_frequency || 'daily';

  // Use separate formatters to avoid the V8 bug where combining 'hour' and
  // 'weekday' in one formatter with hour12:false can return 24 for midnight.
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(now),
    10
  ) % 24; // % 24 guards against V8's "24" representation of midnight

  if (localHour !== targetHour) return false;

  if (freq === 'weekly') {
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    const localDay = WEEKDAYS.indexOf(weekdayStr);
    const targetDay = Number(tenant.digest_day ?? 1);
    return localDay === targetDay;
  }

  return true; // daily
}

/**
 * Returns debug info about what shouldRunTenant sees for a tenant right now.
 * Used by the admin cron-status endpoint.
 */
function tenantCronStatus(tenant, now = new Date()) {
  const tz = tenant.digest_timezone || 'America/New_York';
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(now),
    10
  ) % 24;
  const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(now);
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    tz,
    localTime,
    localHour,
    localDay: WEEKDAYS.indexOf(weekdayStr),
    weekdayStr,
    targetHour: Number(tenant.digest_hour ?? 7),
    targetDay: Number(tenant.digest_day ?? 1),
    freq: tenant.digest_frequency || 'daily',
    wouldRun: shouldRunTenant(tenant, now),
  };
}

/**
 * Run the digest for every active tenant in the database.
 * Falls back to env vars if no tenants are configured.
 * When `respectSchedule` is true (the hourly cron path), only runs tenants
 * whose configured hour/day matches the current time.
 */
async function runAllTenants({ respectSchedule = false } = {}) {
  const { getAllTenants, updateTenantDigestStatus } = require('./db');
  const tenants = await getAllTenants();

  if (tenants.length === 0) {
    console.log('No tenants in database — falling back to environment variables.');
    return runDigest({});
  }

  const now = new Date();
  if (respectSchedule) {
    for (const t of tenants) {
      const s = tenantCronStatus(t, now);
      console.log(`[cron] ${t.name}: localTime=${s.localTime} (${s.tz}), targetHour=${s.targetHour}, wouldRun=${s.wouldRun}`);
    }
  }
  const due = respectSchedule ? tenants.filter((t) => shouldRunTenant(t, now)) : tenants;

  if (due.length === 0) {
    console.log('[cron] No tenants scheduled for this hour.');
    return;
  }

  console.log(`[cron] Running digest for ${due.length} tenant(s)...`);
  for (const tenant of due) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Tenant: ${tenant.name}`);
    try {
      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      await runDigest({
        hubspotApiKey: tenant.hubspot_api_key,
        recipients: tenant.recipient_emails,
        previewUrl: appUrl ? `${appUrl}/dashboard/preview/${tenant.id}` : undefined,
        reportPeriodDays: Number(tenant.report_period_days) || 1,
        tenantId: tenant.id,
      });
      await updateTenantDigestStatus(tenant.id, 'success');
    } catch (err) {
      console.error(`Digest failed for ${tenant.name}:`, err.message);
      await updateTenantDigestStatus(tenant.id, `error: ${err.message.slice(0, 200)}`);
    }
  }
}

// Export state and runner for use by server.js
module.exports = { generateDigest, runDigest, runAllTenants, tenantCronStatus, state };

// Run directly when called as a script
if (require.main === module) {
  const isTest = process.argv.includes('--test');

  // In test mode use env vars; otherwise run all tenants
  const runner = isTest ? runDigest({ isTest: true }) : runAllTenants();
  runner
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
}
