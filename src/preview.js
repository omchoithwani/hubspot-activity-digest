'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

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
  fetchContactsCreated,
  fetchCompaniesCreated,
  getYesterdayTimestamp,
} = require('./hubspot');

const { generateEmailHtml, generateSubject } = require('./emailTemplate');

function formatDateEST(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

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

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('HubSpot Activity Digest — Preview Mode');
  console.log('='.repeat(60));

  const now = new Date();
  const yesterdayTs = getYesterdayTimestamp();
  const dateRange = `${formatDateEST(new Date(yesterdayTs))} → ${formatDateEST(now)}`;
  console.log(`\nFetching activities for: ${dateRange}`);

  const errors = [];

  console.log('\nFetching metadata...');
  const [ownerMap, stageMap] = await Promise.all([
    safelyFetch('Owners', fetchOwners, errors),
    safelyFetch('Deal Stages', fetchDealStages, errors),
  ]);

  console.log('\nFetching activities...');
  const [dealsCreated, dealStageChanges, tasksCompleted] = await Promise.all([
    safelyFetch('Deals Created', () => fetchDealsCreated(yesterdayTs), errors),
    safelyFetch('Deal Stage Changes', () => fetchDealStageChanges(yesterdayTs), errors),
    safelyFetch('Tasks Completed', () => fetchTasksCompleted(yesterdayTs), errors),
  ]);

  await new Promise((r) => setTimeout(r, 500));

  const [callsLogged, emailsSent, meetingsBooked] = await Promise.all([
    safelyFetch('Calls Logged', () => fetchCallsLogged(yesterdayTs), errors),
    safelyFetch('Emails Sent', () => fetchEmailsSent(yesterdayTs), errors),
    safelyFetch('Meetings Booked', () => fetchMeetingsBooked(yesterdayTs), errors),
  ]);

  await new Promise((r) => setTimeout(r, 500));

  const [notesAdded, contactsCreated, companiesCreated] = await Promise.all([
    safelyFetch('Notes Added', () => fetchNotesAdded(yesterdayTs), errors),
    safelyFetch('Contacts Created', () => fetchContactsCreated(yesterdayTs), errors),
    safelyFetch('Companies Created', () => fetchCompaniesCreated(yesterdayTs), errors),
  ]);

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
  };

  const totalActivities = Object.values(data).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`\nTotal activities: ${totalActivities}`);

  const htmlBody = generateEmailHtml({
    dateRange,
    data,
    ownerMap: Array.isArray(ownerMap) ? {} : ownerMap,
    stageMap: Array.isArray(stageMap) ? {} : stageMap,
    errors,
  });

  const subject = generateSubject(formatDateEST(now).split(',')[0], totalActivities);

  const outPath = path.join(__dirname, '..', 'digest-preview.html');
  fs.writeFileSync(outPath, htmlBody, 'utf8');

  console.log(`\n✅ Preview saved!`);
  console.log(`   Subject: ${subject}`);
  console.log(`   File: ${outPath}`);
  console.log('\nOpen it in your browser:');
  console.log(`   open "${outPath}"`);
  console.log('='.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
