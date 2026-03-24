'use strict';

require('dotenv').config();

const {
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

  // For multi-tenant: temporarily set the API key for this run
  const originalKey = process.env.HUBSPOT_ACCESS_TOKEN;
  if (hubspotApiKey) process.env.HUBSPOT_ACCESS_TOKEN = hubspotApiKey;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`HubSpot Activity Digest — ${new Date().toISOString()}`);
  console.log(`Mode: ${isTest ? 'TEST' : 'PRODUCTION'}`);
  console.log('='.repeat(60));

  const now = new Date();

  // Fetch account timezone before anything else
  let accountTimezone = 'America/New_York';
  try {
    const info = await fetchAccountInfo();
    accountTimezone = info.timeZone;
    console.log(`Account timezone: ${accountTimezone}`);
  } catch (err) {
    console.warn(`Could not fetch account timezone, defaulting to ${accountTimezone}:`, err.message);
  }

  const range = getYesterdayRange(accountTimezone);
  const dateRange = `${formatDate(new Date(range.startMs), accountTimezone)} → ${formatDate(new Date(range.endMs), accountTimezone)}`;
  console.log(`\nFetching activities for: ${dateRange}`);

  const errors = [];

  // Fetch owners and stage map first (needed for rendering)
  console.log('\nFetching metadata...');
  const [ownerMap, stageMap] = await Promise.all([
    safelyFetch('Owners', fetchOwners, errors),
    safelyFetch('Deal Stages', fetchDealStages, errors),
  ]);

  // Fetch activity types sequentially in pairs to stay well within HubSpot's
  // per-second search rate limit. Each pair shares one 300ms gap.
  console.log('\nFetching activities...');
  const [dealsCreated, dealStageChanges] = await Promise.all([
    safelyFetch('Deals Created', () => fetchDealsCreated(range), errors),
    safelyFetch('Deal Stage Changes', () => fetchDealStageChanges(range), errors),
  ]);

  await new Promise((r) => setTimeout(r, 300));

  const [tasksCompleted, callsLogged] = await Promise.all([
    safelyFetch('Tasks Completed', () => fetchTasksCompleted(range), errors),
    safelyFetch('Calls Logged', () => fetchCallsLogged(range), errors),
  ]);

  await new Promise((r) => setTimeout(r, 300));

  const [emailsSent, meetingsBooked] = await Promise.all([
    safelyFetch('Emails Sent', () => fetchEmailsSent(range), errors),
    safelyFetch('Meetings Booked', () => fetchMeetingsBooked(range), errors),
  ]);

  await new Promise((r) => setTimeout(r, 300));

  const [notesAdded, contactsCreated] = await Promise.all([
    safelyFetch('Notes Added', () => fetchNotesAdded(range), errors),
    safelyFetch('Contacts Created', () => fetchContactsCreated(range), errors),
  ]);

  await new Promise((r) => setTimeout(r, 300));

  const [companiesCreated] = await Promise.all([
    safelyFetch('Companies Created', () => fetchCompaniesCreated(range), errors),
  ]);

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
  });

  const subject = generateSubject(formatDate(now, accountTimezone).split(',')[0], totalActivities);

  // If preview mode, skip email and return HTML directly
  if (skipEmail) {
    if (hubspotApiKey) process.env.HUBSPOT_ACCESS_TOKEN = originalKey;
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
  try {
    await sendEmail({ toEmails: recipients, subject, htmlBody });
  } finally {
    // Restore original API key after this tenant's run
    if (hubspotApiKey) process.env.HUBSPOT_ACCESS_TOKEN = originalKey;
  }

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
 * Run the digest for every active tenant in the database.
 * Falls back to env vars if no tenants are configured.
 */
async function runAllTenants() {
  const { getAllTenants, updateTenantDigestStatus } = require('./db');
  const tenants = await getAllTenants();

  if (tenants.length === 0) {
    console.log('No tenants in database — falling back to environment variables.');
    return runDigest({});
  }

  console.log(`Running digest for ${tenants.length} tenant(s)...`);
  for (const tenant of tenants) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Tenant: ${tenant.name}`);
    try {
      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      await runDigest({
        hubspotApiKey: tenant.hubspot_api_key,
        recipients: tenant.recipient_emails,
        previewUrl: appUrl ? `${appUrl}/dashboard/preview/${tenant.id}` : undefined,
      });
      await updateTenantDigestStatus(tenant.id, 'success');
    } catch (err) {
      console.error(`Digest failed for ${tenant.name}:`, err.message);
      await updateTenantDigestStatus(tenant.id, `error: ${err.message.slice(0, 200)}`);
    }
  }
}

// Export state and runner for use by server.js
module.exports = { generateDigest, runDigest, runAllTenants, state };

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
