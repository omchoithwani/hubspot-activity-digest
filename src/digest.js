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
  sendEmail,
  fetchAccountInfo,
  getYesterdayRange,
  fetchFormsSubmitted,
} = require('./hubspot');

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
  const { isTest = false } = options;

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

  // Fetch all activity types in parallel
  console.log('\nFetching activities...');
  const [
    dealsCreated,
    dealStageChanges,
    tasksCompleted,
    callsLogged,
    emailsSent,
    meetingsBooked,
    notesAdded,
    contactsCreated,
    companiesCreated,
  ] = await Promise.all([
    safelyFetch('Deals Created', () => fetchDealsCreated(range), errors),
    safelyFetch('Deal Stage Changes', () => fetchDealStageChanges(range), errors),
    safelyFetch('Tasks Completed', () => fetchTasksCompleted(range), errors),
    safelyFetch('Calls Logged', () => fetchCallsLogged(range), errors),
    safelyFetch('Emails Sent', () => fetchEmailsSent(range), errors),
    safelyFetch('Meetings Booked', () => fetchMeetingsBooked(range), errors),
    safelyFetch('Notes Added', () => fetchNotesAdded(range), errors),
    safelyFetch('Contacts Created', () => fetchContactsCreated(range), errors),
    safelyFetch('Companies Created', () => fetchCompaniesCreated(range), errors),
  ]);

  // Form submissions are sequential (one request per form), fetch after the parallel batch
  const formsSubmitted = await safelyFetch('Form Submissions', () => fetchFormsSubmitted(range), errors);

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
  });

  const subject = generateSubject(formatDate(now, accountTimezone).split(',')[0], totalActivities);

  // Determine recipients
  let recipients;
  if (isTest) {
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
  await sendEmail({
    toEmails: recipients,
    subject,
    htmlBody,
  });

  console.log(`\n✅ Digest sent successfully!`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Recipients: ${recipients.join(', ')}`);
  console.log(`   Total activities: ${totalActivities}`);
  console.log('='.repeat(60) + '\n');

  return { success: true, totalActivities, errors };
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

// Export state and runner for use by server.js
module.exports = { runDigest, state };

// Run directly when called as a script
if (require.main === module) {
  const isTest = process.argv.includes('--test');

  runDigest({ isTest })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error:', err.message);
      process.exit(1);
    });
}
