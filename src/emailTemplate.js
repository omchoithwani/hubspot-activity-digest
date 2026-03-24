'use strict';

// AeroRev brand colors
const NAVY = '#080E1A';
const LIME = '#C8F04A';
const LIGHT_NAVY = '#141D2E';
const GRAY = '#8892A4';
const LIGHT_GRAY = '#F4F5F7';
const WHITE = '#FFFFFF';
const SUCCESS = '#22C55E';
const WARNING = '#F59E0B';
const DANGER = '#EF4444';

/**
 * Format a currency amount
 */
function formatAmount(amount) {
  if (!amount) return null;
  const num = parseFloat(amount);
  if (isNaN(num)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

/**
 * Format a date string (with time)
 */
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format a date string (date only, no time)
 */
function formatDateOnly(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Truncate text to maxLen chars
 */
function truncate(text, maxLen = 120) {
  if (!text) return '';
  const cleaned = text.replace(/<[^>]+>/g, '').trim();
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + '...' : cleaned;
}

/**
 * Render a summary card
 */
function summaryCard(icon, label, count, color = NAVY) {
  return `
    <td style="width:25%;padding:8px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${LIGHT_NAVY};border-radius:10px;overflow:hidden;">
        <tr>
          <td style="padding:18px 16px;text-align:center;">
            <div style="font-size:28px;margin-bottom:6px;">${icon}</div>
            <div style="font-size:28px;font-weight:700;color:${LIME};font-family:Arial,sans-serif;line-height:1;">${count}</div>
            <div style="font-size:11px;color:${GRAY};margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;font-family:Arial,sans-serif;">${label}</div>
          </td>
        </tr>
      </table>
    </td>`;
}

/**
 * Render a section header
 */
function sectionHeader(icon, title, count) {
  return `
    <tr>
      <td style="padding:24px 0 8px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="border-bottom:2px solid ${LIME};padding-bottom:10px;">
              <span style="font-size:18px;font-weight:700;color:${WHITE};font-family:Arial,sans-serif;">
                ${icon} ${title}
              </span>
              <span style="display:inline-block;background:${LIME};color:${NAVY};font-size:12px;font-weight:700;padding:2px 10px;border-radius:20px;margin-left:10px;font-family:Arial,sans-serif;">${count}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Render a table row item
 */
function activityRow(cells, isAlt = false) {
  const bg = isAlt ? '#1A2235' : LIGHT_NAVY;
  return `
    <tr style="background:${bg};">
      ${cells.map((cell) => `<td style="padding:10px 14px;font-size:13px;color:${GRAY};font-family:Arial,sans-serif;border-bottom:1px solid #222D42;">${cell}</td>`).join('')}
    </tr>`;
}

/**
 * Render a table with headers
 */
function activityTable(headers, rows) {
  if (rows.length === 0) return `<tr><td><p style="color:${GRAY};font-style:italic;font-family:Arial,sans-serif;font-size:13px;padding:10px 0;">No activity recorded.</p></td></tr>`;
  return `
    <tr>
      <td style="padding-bottom:20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:8px;overflow:hidden;border:1px solid #222D42;">
          <tr style="background:#222D42;">
            ${headers.map((h) => `<th style="padding:10px 14px;font-size:11px;font-weight:700;color:${LIME};text-align:left;text-transform:uppercase;letter-spacing:0.5px;font-family:Arial,sans-serif;">${h}</th>`).join('')}
          </tr>
          ${rows.map((r, i) => activityRow(r, i % 2 === 1)).join('')}
        </table>
      </td>
    </tr>`;
}

/**
 * Render a badge/pill
 */
function badge(text, bg = NAVY, color = LIME) {
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;font-family:Arial,sans-serif;">${text}</span>`;
}

/**
 * Arrow badge for stage transitions
 */
function stageBadge(from, to) {
  return `${badge(from, '#2A1A0A', WARNING)} &rarr; ${badge(to, '#0A2A1A', SUCCESS)}`;
}

/**
 * Main function to generate the HTML email
 */
function generateEmailHtml({ dateRange, data, ownerMap, stageMap, errors }) {
  const {
    dealsCreated = [],
    dealStageChanges = [],
    tasksCompleted = [],
    callsLogged = [],
    emailsSent = [],
    meetingsBooked = [],
    notesAdded = [],
    contactsCreated = [],
    companiesCreated = [],
    formsSubmitted = [],
    noteAssociations = {},
  } = data;

  function ownerName(id) {
    if (!id) return '—';
    return ownerMap[id]?.name || `Owner ${id}`;
  }

  function stageName(id) {
    if (!id) return id;
    return stageMap[id]?.label || id;
  }

  const totalFormSubmissions = formsSubmitted.reduce((s, f) => s + f.count, 0);

  const totalActivities =
    dealsCreated.length +
    dealStageChanges.length +
    tasksCompleted.length +
    callsLogged.length +
    emailsSent.length +
    meetingsBooked.length +
    notesAdded.length +
    contactsCreated.length +
    companiesCreated.length +
    totalFormSubmissions;

  const noActivity = totalActivities === 0;

  // Summary cards row (2 rows of 4)
  const summaryItems = [
    { icon: '💼', label: 'Deals Created', count: dealsCreated.length },
    { icon: '🔄', label: 'Stage Changes', count: dealStageChanges.length },
    { icon: '✅', label: 'Tasks Done', count: tasksCompleted.length },
    { icon: '📞', label: 'Calls Logged', count: callsLogged.length },
    { icon: '📧', label: 'Emails Sent', count: emailsSent.length },
    { icon: '📅', label: 'Meetings', count: meetingsBooked.length },
    { icon: '📝', label: 'Notes Added', count: notesAdded.length },
    { icon: '👤', label: 'New Contacts', count: contactsCreated.length },
    { icon: '📋', label: 'Form Submits', count: totalFormSubmissions },
    { icon: '🏢', label: 'New Companies', count: companiesCreated.length },
  ];

  const summaryRow1 = summaryItems.slice(0, 4);
  const summaryRow2 = summaryItems.slice(4, 8);
  const summaryRow3 = summaryItems.slice(8, 10);

  // Deals created table
  const dealsCreatedRows = dealsCreated.map((d) => {
    const amount = formatAmount(d.properties?.amount);
    const pipeline = stageMap[d.properties?.dealstage]?.pipeline || '—';
    return [
      `<strong style="color:${WHITE};">${d.properties?.dealname || 'Unnamed Deal'}</strong>`,
      formatDateOnly(d.properties?.createdate),
      pipeline,
      stageName(d.properties?.dealstage) || '—',
      amount ? `<span style="color:${LIME};">${amount}</span>` : '—',
      ownerName(d.properties?.hubspot_owner_id),
    ];
  });

  // Deal stage changes table
  const stageChangeRows = dealStageChanges.map((d) => [
    `<strong style="color:${WHITE};">${d.dealname || 'Unnamed Deal'}</strong>`,
    stageBadge(stageName(d.fromStage), stageName(d.toStage)),
    ownerName(d.hubspot_owner_id),
    formatDate(d.changedAt),
  ]);

  // Tasks completed table
  const tasksRows = tasksCompleted.map((t) => [
    `<strong style="color:${WHITE};">${t.properties?.hs_task_subject || 'Untitled Task'}</strong>`,
    t.properties?.hs_task_type || '—',
    formatDateOnly(t.properties?.hs_task_due_date),
    ownerName(t.properties?.hubspot_owner_id),
  ]);

  // Calls logged table
  const callsRows = callsLogged.map((c) => {
    const duration = c.properties?.hs_call_duration;
    const durationStr = duration ? `${Math.round(duration / 60000)}m` : '—';
    return [
      `<strong style="color:${WHITE};">${c.properties?.hs_call_title || 'Call'}</strong>`,
      formatDate(c.properties?.hs_createdate),
      c.properties?.hs_call_direction || '—',
      durationStr,
      ownerName(c.properties?.hubspot_owner_id),
    ];
  });

  // Emails sent table
  const emailRows = emailsSent.map((e) => [
    `<strong style="color:${WHITE};">${e.properties?.hs_email_subject || 'No Subject'}</strong>`,
    e.properties?.hs_email_to_email || '—',
    badge(e.properties?.hs_email_status || 'SENT', '#0A1A2A', LIME),
    ownerName(e.properties?.hubspot_owner_id),
  ]);

  // Meetings table
  const meetingRows = meetingsBooked.map((m) => [
    `<strong style="color:${WHITE};">${m.properties?.hs_meeting_title || 'Meeting'}</strong>`,
    formatDate(m.properties?.hs_meeting_start_time),
    badge(m.properties?.hs_meeting_outcome || 'SCHEDULED', '#0A2A1A', SUCCESS),
    ownerName(m.properties?.hubspot_owner_id),
  ]);

  // Notes table
  const noteRows = notesAdded.map((n) => {
    const assoc = noteAssociations[n.id] || { contacts: [], deals: [] };
    return [
      `<span style="color:${WHITE};">${truncate(n.properties?.hs_note_body, 100) || 'No content'}</span>`,
      assoc.contacts.length > 0 ? assoc.contacts.join(', ') : '—',
      assoc.deals.length > 0 ? assoc.deals.join(', ') : '—',
      ownerName(n.properties?.hubspot_owner_id),
    ];
  });

  // Contacts created table
  const contactRows = contactsCreated.map((c) => {
    const name = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || 'Unknown';
    return [
      `<strong style="color:${WHITE};">${name}</strong>`,
      c.properties?.email || '—',
      c.properties?.company || '—',
      formatDateOnly(c.properties?.createdate),
      ownerName(c.properties?.hubspot_owner_id),
    ];
  });

  // Companies created table
  const companyRows = companiesCreated.map((c) => [
    `<strong style="color:${WHITE};">${c.properties?.name || 'Unknown'}</strong>`,
    c.properties?.domain || '—',
    c.properties?.industry || '—',
    formatDateOnly(c.properties?.createdate),
    ownerName(c.properties?.hubspot_owner_id),
  ]);

  // Form submissions — flat table: one row per submission across all forms
  const formSubmissionRows = formsSubmitted.flatMap((form) =>
    form.submissions.map((sub) => {
      const vals = Object.fromEntries((sub.values || []).map((v) => [v.name, v.value]));
      const email = vals.email || vals.EMAIL || '—';
      const firstName = vals.firstname || vals.FIRSTNAME || vals.first_name || '';
      const lastName = vals.lastname || vals.LASTNAME || vals.last_name || '';
      const name = [firstName, lastName].filter(Boolean).join(' ') || '—';
      const pageUrl = sub.pageUrl ? truncate(sub.pageUrl, 50) : '—';
      return [
        `<strong style="color:${WHITE};">${form.formName}</strong>`,
        formatDate(new Date(sub.submittedAt).toISOString()),
        email,
        name,
        pageUrl,
      ];
    })
  );

  const errorsSection = errors && errors.length > 0 ? `
    <tr>
      <td style="padding:16px;background:#2A1A1A;border-radius:8px;margin-top:20px;border-left:4px solid ${DANGER};">
        <p style="color:${DANGER};font-weight:700;font-family:Arial,sans-serif;font-size:13px;margin:0 0 8px 0;">⚠️ Some data could not be retrieved:</p>
        <ul style="color:${GRAY};font-size:12px;font-family:Arial,sans-serif;margin:0;padding-left:16px;">
          ${errors.map((e) => `<li>${e}</li>`).join('')}
        </ul>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HubSpot Activity Digest</title>
</head>
<body style="margin:0;padding:0;background:#0A0F1C;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0A0F1C;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:${NAVY};border-radius:12px 12px 0 0;padding:28px 32px;border-bottom:3px solid ${LIME};">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:22px;font-weight:800;color:${WHITE};font-family:Arial,sans-serif;letter-spacing:-0.5px;">
                      AeroRev <span style="color:${LIME};">HubSpot</span> Digest
                    </div>
                    <div style="font-size:13px;color:${GRAY};margin-top:4px;font-family:Arial,sans-serif;">
                      Activity Report &bull; ${dateRange}
                    </div>
                  </td>
                  <td align="right">
                    <div style="font-size:36px;">📊</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:${NAVY};padding:24px 32px;border-radius:0 0 12px 12px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">

                ${noActivity ? `
                <tr>
                  <td style="text-align:center;padding:40px 0;">
                    <div style="font-size:48px;margin-bottom:16px;">😴</div>
                    <p style="color:${GRAY};font-size:16px;font-family:Arial,sans-serif;">No activity recorded in the last 24 hours.</p>
                  </td>
                </tr>` : `

                <!-- Summary Cards Row 1 -->
                <tr>
                  <td style="padding-bottom:8px;">
                    <p style="color:${GRAY};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;font-family:Arial,sans-serif;margin:0 0 10px 0;">Activity Summary</p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        ${summaryRow1.map((s) => summaryCard(s.icon, s.label, s.count)).join('')}
                      </tr>
                      <tr>
                        ${summaryRow2.map((s) => summaryCard(s.icon, s.label, s.count)).join('')}
                      </tr>
                      <tr>
                        ${summaryRow3.map((s) => summaryCard(s.icon, s.label, s.count)).join('')}
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Divider -->
                <tr><td style="height:8px;"></td></tr>

                <!-- Deals Created -->
                ${dealsCreated.length > 0 ? `
                ${sectionHeader('💼', 'Deals Created', dealsCreated.length)}
                ${activityTable(
                  ['Deal Name', 'Created', 'Pipeline', 'Stage', 'Amount', 'Owner'],
                  dealsCreatedRows
                )}` : ''}

                <!-- Deal Stage Changes -->
                ${dealStageChanges.length > 0 ? `
                ${sectionHeader('🔄', 'Deal Stage Changes', dealStageChanges.length)}
                ${activityTable(
                  ['Deal Name', 'Stage Transition', 'Owner', 'Changed At'],
                  stageChangeRows
                )}` : ''}

                <!-- Tasks Completed -->
                ${tasksCompleted.length > 0 ? `
                ${sectionHeader('✅', 'Tasks Completed', tasksCompleted.length)}
                ${activityTable(
                  ['Task Subject', 'Type', 'Due Date', 'Owner'],
                  tasksRows
                )}` : ''}

                <!-- Calls Logged -->
                ${callsLogged.length > 0 ? `
                ${sectionHeader('📞', 'Calls Logged', callsLogged.length)}
                ${activityTable(
                  ['Title', 'Time', 'Direction', 'Duration', 'Owner'],
                  callsRows
                )}` : ''}

                <!-- Emails Sent -->
                ${emailsSent.length > 0 ? `
                ${sectionHeader('📧', 'Emails Sent', emailsSent.length)}
                ${activityTable(
                  ['Subject', 'To', 'Status', 'Owner'],
                  emailRows
                )}` : ''}

                <!-- Meetings Booked -->
                ${meetingsBooked.length > 0 ? `
                ${sectionHeader('📅', 'Meetings Booked', meetingsBooked.length)}
                ${activityTable(
                  ['Title', 'Start Time', 'Outcome', 'Owner'],
                  meetingRows
                )}` : ''}

                <!-- Notes Added -->
                ${notesAdded.length > 0 ? `
                ${sectionHeader('📝', 'Notes Added', notesAdded.length)}
                ${activityTable(
                  ['Note Preview', 'Contact', 'Deal', 'Owner'],
                  noteRows
                )}` : ''}

                <!-- Contacts Created -->
                ${contactsCreated.length > 0 ? `
                ${sectionHeader('👤', 'Contacts Created', contactsCreated.length)}
                ${activityTable(
                  ['Name', 'Email', 'Company', 'Created', 'Owner'],
                  contactRows
                )}` : ''}

                <!-- Companies Created -->
                ${companiesCreated.length > 0 ? `
                ${sectionHeader('🏢', 'Companies Created', companiesCreated.length)}
                ${activityTable(
                  ['Company Name', 'Domain', 'Industry', 'Created', 'Owner'],
                  companyRows
                )}` : ''}

                <!-- Form Submissions -->
                ${totalFormSubmissions > 0 ? `
                ${sectionHeader('📋', 'Form Submissions', totalFormSubmissions)}
                ${activityTable(
                  ['Form', 'Submitted At', 'Email', 'Name', 'Page'],
                  formSubmissionRows
                )}` : ''}

                `}

                <!-- Errors -->
                ${errorsSection}

                <!-- Footer -->
                <tr>
                  <td style="padding-top:24px;border-top:1px solid #222D42;text-align:center;">
                    <p style="color:${GRAY};font-size:11px;font-family:Arial,sans-serif;margin:0;">
                      Automated digest generated by <strong style="color:${LIME};">AeroRev HubSpot Digest</strong><br>
                      Powered by HubSpot CRM &bull; Running on Render.com<br>
                      <span style="opacity:0.6;">To change recipients, update RECIPIENT_EMAILS in Render environment variables.</span>
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Generate email subject line
 */
function generateSubject(dateRange, totalCount) {
  if (totalCount === 0) {
    return `HubSpot Digest: No Activity — ${dateRange}`;
  }
  return `HubSpot Digest: ${totalCount} Activities — ${dateRange}`;
}

module.exports = { generateEmailHtml, generateSubject };
