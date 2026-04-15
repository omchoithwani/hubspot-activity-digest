'use strict';

// AeroRev brand — matches aero-rev.com
// Fonts: Syne (headings), DM Sans (body) — with Arial fallbacks for email clients
const WHITE      = '#FFFFFF';
const BLACK      = '#000000';
const RED        = '#E40014';
const LIGHT_GRAY = '#F5F5F7';
const BORDER     = '#E5E7EB';
const TEXT_MAIN  = '#111111';
const TEXT_MUTED = '#6B7280';
const ROW_ALT    = '#FAFAFA';
const SUCCESS    = '#15803D';
const WARNING    = '#B45309';
const DANGER     = '#DC2626';

// When a single object type has >= this many records created in the window,
// we assume it was a bulk import or integration sync and show a summary
// instead of a (potentially thousands-of-rows) table.
const BULK_THRESHOLD = 50;

// Max rows shown per section in the email. If exceeded, a "View more" link is shown.
const VIEW_MORE_LIMIT = 25;

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
function summaryCard(label, count) {
  return `
    <td style="width:25%;padding:6px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${WHITE};border:1px solid ${BORDER};border-radius:8px;">
        <tr>
          <td style="padding:16px 12px;text-align:center;">
            <div style="font-size:26px;font-weight:700;color:${BLACK};font-family:'DM Sans',Arial,sans-serif;line-height:1;">${count}</div>
            <div style="font-size:11px;color:${TEXT_MUTED};margin-top:5px;text-transform:uppercase;letter-spacing:0.6px;font-family:'DM Sans',Arial,sans-serif;">${label}</div>
          </td>
        </tr>
      </table>
    </td>`;
}

/**
 * Render a section header
 */
function sectionHeader(title, count) {
  return `
    <tr>
      <td style="padding:28px 0 10px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="border-bottom:2px solid ${BLACK};padding-bottom:10px;">
              <span style="font-size:15px;font-weight:700;color:${BLACK};font-family:'Syne',Arial,sans-serif;text-transform:uppercase;letter-spacing:0.05em;">
                ${title}
              </span>
              <span style="display:inline-block;background:${RED};color:${WHITE};font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;margin-left:10px;font-family:'DM Sans',Arial,sans-serif;">${count}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Render a table row
 */
function activityRow(cells, isAlt = false) {
  const bg = isAlt ? ROW_ALT : WHITE;
  return `
    <tr style="background:${bg};">
      ${cells.map((cell) => `<td style="padding:10px 14px;font-size:13px;color:${TEXT_MAIN};font-family:'DM Sans',Arial,sans-serif;border-bottom:1px solid ${BORDER};">${cell}</td>`).join('')}
    </tr>`;
}

/**
 * Render a table with headers.
 * If rows exceed VIEW_MORE_LIMIT and a viewMoreUrl is provided, truncates and adds a link row.
 */
function activityTable(headers, rows, viewMoreUrl, showAll = false) {
  if (rows.length === 0) return `<tr><td><p style="color:${TEXT_MUTED};font-style:italic;font-family:'DM Sans',Arial,sans-serif;font-size:13px;padding:8px 0;">No activity recorded.</p></td></tr>`;

  const truncated = !showAll && rows.length > VIEW_MORE_LIMIT;
  const visibleRows = truncated ? rows.slice(0, VIEW_MORE_LIMIT) : rows;
  const hiddenCount = rows.length - VIEW_MORE_LIMIT;

  const viewMoreRow = truncated ? `
    <tr style="background:${LIGHT_GRAY};">
      <td colspan="${headers.length}" style="padding:12px 14px;text-align:center;border-top:1px solid ${BORDER};">
        ${viewMoreUrl
          ? `<a href="${viewMoreUrl}" style="font-size:12px;font-weight:700;color:${RED};font-family:'DM Sans',Arial,sans-serif;text-decoration:none;">View ${hiddenCount} more record${hiddenCount !== 1 ? 's' : ''} &rarr;</a>`
          : `<span style="font-size:12px;color:${TEXT_MUTED};font-family:'DM Sans',Arial,sans-serif;">+ ${hiddenCount} more record${hiddenCount !== 1 ? 's' : ''} not shown</span>`
        }
      </td>
    </tr>` : '';

  return `
    <tr>
      <td style="padding-bottom:20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
          <tr style="background:${LIGHT_GRAY};">
            ${headers.map((h) => `<th style="padding:9px 14px;font-size:11px;font-weight:700;color:${TEXT_MUTED};text-align:left;text-transform:uppercase;letter-spacing:0.6px;font-family:'DM Sans',Arial,sans-serif;border-bottom:1px solid ${BORDER};">${h}</th>`).join('')}
          </tr>
          ${visibleRows.map((r, i) => activityRow(r, i % 2 === 1)).join('')}
          ${viewMoreRow}
        </table>
      </td>
    </tr>`;
}

/**
 * Render a bulk-import summary block instead of a full table.
 * Used when a record type exceeds BULK_THRESHOLD creations in the window.
 */
function bulkSummaryBlock(count, label) {
  return `
    <tr>
      <td style="padding-bottom:20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="border:1px solid ${BORDER};border-radius:8px;overflow:hidden;background:${LIGHT_GRAY};">
          <tr>
            <td style="padding:18px 20px;">
              <span style="font-size:28px;font-weight:700;color:${BLACK};font-family:'DM Sans',Arial,sans-serif;">${count}</span>
              <span style="font-size:15px;color:${TEXT_MUTED};margin-left:8px;font-family:'DM Sans',Arial,sans-serif;">${label} created</span>
              <div style="font-size:12px;color:${TEXT_MUTED};margin-top:6px;font-family:'DM Sans',Arial,sans-serif;">
                Volume suggests a bulk import or data integration sync — individual records not listed.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

/**
 * Render a badge/pill
 */
function badge(text, bg = LIGHT_GRAY, color = TEXT_MAIN) {
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;border:1px solid ${BORDER};font-family:'DM Sans',Arial,sans-serif;">${text}</span>`;
}

/**
 * Arrow badge for stage transitions
 */
function stageBadge(from, to) {
  return `${badge(from, '#FEF3C7', WARNING)} &rarr; ${badge(to, '#DCFCE7', SUCCESS)}`;
}

/**
 * Generate a stacked bar chart (inline SVG) of calls per owner broken down by outcome.
 * Safe for email — no JavaScript required.
 */
function callsByOwnerChart(calls, ownerMap, dispositionMap) {
  if (!calls || calls.length === 0) return '';

  // ── Aggregate data ────────────────────────────────────────────────────────
  const ownerData = {};   // { ownerName: { dispositionLabel: count } }
  const dispositionSet = new Set();

  for (const call of calls) {
    const ownerId  = call.properties?.hubspot_owner_id;
    const owner    = ownerMap[ownerId];
    const name     = owner
      ? (owner.name || `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Unknown')
      : 'Unassigned';

    const dispId    = call.properties?.hs_call_disposition;
    const dispLabel = dispId && dispositionMap[dispId] ? dispositionMap[dispId]
                    : dispId ? 'Other' : 'No Outcome';

    if (!ownerData[name]) ownerData[name] = {};
    ownerData[name][dispLabel] = (ownerData[name][dispLabel] || 0) + 1;
    dispositionSet.add(dispLabel);
  }

  // Sort owners by total calls descending, cap at 20 for readability
  const owners = Object.keys(ownerData)
    .sort((a, b) =>
      Object.values(ownerData[b]).reduce((s, n) => s + n, 0) -
      Object.values(ownerData[a]).reduce((s, n) => s + n, 0)
    )
    .slice(0, 20);

  const dispositions = [...dispositionSet].sort();

  // ── Color palette ─────────────────────────────────────────────────────────
  const COLOR_MAP = {
    connected:       '#10B981',
    'no answer':     '#EF4444',
    voicemail:       '#F59E0B',
    'live message':  '#3B82F6',
    busy:            '#8B5CF6',
    'wrong number':  '#EC4899',
    'no outcome':    '#9CA3AF',
  };
  const PALETTE = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#F97316','#84CC16'];
  let paletteIdx = 0;
  const colorOf = {};
  for (const d of dispositions) {
    const key = Object.keys(COLOR_MAP).find(k => d.toLowerCase().includes(k));
    colorOf[d] = key ? COLOR_MAP[key] : PALETTE[paletteIdx++ % PALETTE.length];
  }

  // ── SVG layout ────────────────────────────────────────────────────────────
  const W = 560, PAD_L = 38, PAD_R = 10, PAD_T = 12, PAD_B = 48;
  const CHART_W = W - PAD_L - PAD_R;
  const CHART_H = 170;
  const H = PAD_T + CHART_H + PAD_B;

  const maxTotal = Math.max(...owners.map(o =>
    Object.values(ownerData[o]).reduce((s, n) => s + n, 0)
  ));
  const step  = maxTotal <= 10 ? 1 : maxTotal <= 50 ? 5 : maxTotal <= 200 ? 10 : 25;
  const yMax  = Math.max(1, Math.ceil(maxTotal / step) * step);

  const slotW = CHART_W / owners.length;
  const barW  = Math.max(6, Math.min(48, slotW * 0.65));

  // Y axis grid lines + labels
  const GRID_STEPS = Math.min(5, yMax);
  const gridLines = Array.from({ length: GRID_STEPS + 1 }, (_, i) => {
    const val = Math.round(yMax * i / GRID_STEPS);
    const y   = (PAD_T + CHART_H - (val / yMax) * CHART_H).toFixed(1);
    return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#E5E7EB" stroke-width="1"/>` +
           `<text x="${PAD_L - 4}" y="${(+y + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#9CA3AF" font-family="Arial,sans-serif">${val}</text>`;
  }).join('');

  // Bars
  const bars = owners.map((owner, i) => {
    const cx    = PAD_L + slotW * i + slotW / 2;
    const bx    = (cx - barW / 2).toFixed(1);
    let   accH  = 0;
    const segs  = dispositions.map(d => {
      const cnt = ownerData[owner][d] || 0;
      if (!cnt) return '';
      const segH = ((cnt / yMax) * CHART_H);
      const ry   = (PAD_T + CHART_H - accH - segH).toFixed(1);
      accH += segH;
      return `<rect x="${bx}" y="${ry}" width="${barW}" height="${segH.toFixed(1)}" fill="${colorOf[d]}" rx="1"/>`;
    }).join('');
    const total = Object.values(ownerData[owner]).reduce((s, n) => s + n, 0);
    // First name only, max 9 chars
    const label = owner.split(' ')[0].substring(0, 9);
    const labelY = (PAD_T + CHART_H + 13).toFixed(1);
    const totalY = (PAD_T + CHART_H - accH - 3).toFixed(1);
    return segs +
      `<text x="${cx.toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="9" fill="#374151" font-family="Arial,sans-serif">${label}</text>` +
      (accH > 0 ? `<text x="${cx.toFixed(1)}" y="${totalY}" text-anchor="middle" font-size="9" fill="#6B7280" font-family="Arial,sans-serif">${total}</text>` : '');
  }).join('');

  // Legend
  const LEG_COL_W = 155;
  const LEG_COLS  = Math.min(3, dispositions.length);
  const legItems  = dispositions.map((d, i) => {
    const lx = (i % LEG_COLS) * LEG_COL_W;
    const ly = Math.floor(i / LEG_COLS) * 16;
    return `<rect x="${lx}" y="${ly}" width="9" height="9" fill="${colorOf[d]}" rx="2"/>` +
           `<text x="${lx + 13}" y="${ly + 9}" font-size="10" fill="#374151" font-family="Arial,sans-serif">${d}</text>`;
  }).join('');
  const legH = Math.ceil(dispositions.length / LEG_COLS) * 16 + 8;
  const legW = Math.min(dispositions.length, LEG_COLS) * LEG_COL_W;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
      <tr><td style="padding:0 0 4px 0;">
        <p style="margin:0;font-size:11px;color:${TEXT_MUTED};font-family:Arial,sans-serif;">Calls by rep &amp; outcome</p>
      </td></tr>
      <tr><td>
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;max-width:100%;">
          ${gridLines}
          <line x1="${PAD_L}" y1="${PAD_T + CHART_H}" x2="${W - PAD_R}" y2="${PAD_T + CHART_H}" stroke="#D1D5DB" stroke-width="1"/>
          ${bars}
        </svg>
      </td></tr>
      <tr><td style="padding-top:6px;">
        <svg width="${legW}" height="${legH}" viewBox="0 0 ${legW} ${legH}" xmlns="http://www.w3.org/2000/svg" style="display:block;">
          <g transform="translate(${PAD_L},0)">${legItems}</g>
        </svg>
      </td></tr>
    </table>`;
}

/**
 * Main function to generate the HTML email
 */
function generateEmailHtml({ dateRange, data, ownerMap, stageMap, dispositionMap = {}, errors, previewUrl, showAll = false }) {
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
    adLeads = [],
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
    totalFormSubmissions +
    adLeads.length;

  const noActivity = totalActivities === 0;

  // Summary cards
  const summaryItems = [
    { label: 'Deals Created',  count: dealsCreated.length },
    { label: 'Stage Changes',  count: dealStageChanges.length },
    { label: 'Tasks Done',     count: tasksCompleted.length },
    { label: 'Calls Logged',   count: callsLogged.length },
    { label: 'Emails Sent',    count: emailsSent.length },
    { label: 'Meetings',       count: meetingsBooked.length },
    { label: 'Notes Added',    count: notesAdded.length },
    { label: 'New Contacts',   count: contactsCreated.length },
    { label: 'Form Submits',   count: totalFormSubmissions },
    { label: 'New Companies',  count: companiesCreated.length },
  ];

  const summaryRow1 = summaryItems.slice(0, 4);
  const summaryRow2 = summaryItems.slice(4, 8);
  const summaryRow3 = summaryItems.slice(8, 10);

  // Normalise ad platform name from hs_latest_source_data_1
  function platformLabel(raw) {
    if (!raw) return 'Unknown';
    const s = raw.toLowerCase().replace(/\.com$/, '');
    if (s.includes('google'))    return 'Google';
    if (s.includes('facebook'))  return 'Facebook';
    if (s.includes('instagram')) return 'Instagram';
    if (s.includes('linkedin'))  return 'LinkedIn';
    if (s.includes('twitter') || s.includes('x.com')) return 'X / Twitter';
    if (s.includes('tiktok'))    return 'TikTok';
    if (s.includes('bing') || s.includes('microsoft')) return 'Bing';
    if (s.includes('youtube'))   return 'YouTube';
    // Capitalise whatever it is
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  // Build per-platform summary for ad leads
  const adLeadsByPlatform = {};
  for (const lead of adLeads) {
    const platform = platformLabel(lead.properties?.hs_latest_source_data_1);
    if (!adLeadsByPlatform[platform]) adLeadsByPlatform[platform] = 0;
    adLeadsByPlatform[platform]++;
  }

  // Build ad leads table rows
  const adLeadRows = adLeads.map((lead) => {
    const p = lead.properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || '—';
    // Prefer latest-touch attribution; fall back to first-touch (hs_analytics_source_data_*)
    const rawPlatform = p.hs_latest_source_data_1 || p.hs_analytics_source_data_1;
    const platform = platformLabel(rawPlatform);
    const campaign = p.hs_latest_source_data_2 || p.hs_analytics_source_data_2 || '—';
    const PAID = new Set(['PAID_SEARCH', 'PAID_SOCIAL']);
    const source = PAID.has(p.hs_latest_source) ? p.hs_latest_source
                 : PAID.has(p.hs_analytics_source) ? p.hs_analytics_source
                 : p.hs_latest_source || '—';
    const sourceLabel = source === 'PAID_SEARCH' ? 'Search' : source === 'PAID_SOCIAL' ? 'Social' : source;
    return [
      `<strong>${name}</strong>`,
      p.email || '—',
      p.company || '—',
      `${platform}<span style="color:${TEXT_MUTED};font-size:11px;margin-left:4px;">(${sourceLabel})</span>`,
      campaign,
      formatDateOnly(p.createdate),
    ];
  });

  // Build per-user activity breakdown
  const userActivity = {};

  function userEntry(id) {
    const key = id || '__unassigned__';
    if (!userActivity[key]) {
      userActivity[key] = {
        id: key,
        dealsCreated: 0,
        dealValue: 0,
        stageChanges: 0,
        tasks: 0,
        calls: 0,
        emails: 0,
        meetings: 0,
        notes: 0,
        contacts: 0,
        companies: 0,
      };
    }
    return userActivity[key];
  }

  dealsCreated.forEach((d) => {
    const u = userEntry(d.properties?.hubspot_owner_id);
    u.dealsCreated++;
    const amt = parseFloat(d.properties?.amount);
    if (!isNaN(amt)) u.dealValue += amt;
  });
  dealStageChanges.forEach((d) => { userEntry(d.hubspot_owner_id).stageChanges++; });
  tasksCompleted.forEach((t) => { userEntry(t.properties?.hubspot_owner_id).tasks++; });
  callsLogged.forEach((c) => { userEntry(c.properties?.hubspot_owner_id).calls++; });
  emailsSent.forEach((e) => { userEntry(e.properties?.hubspot_owner_id).emails++; });
  meetingsBooked.forEach((m) => { userEntry(m.properties?.hubspot_owner_id).meetings++; });
  notesAdded.forEach((n) => { userEntry(n.properties?.hubspot_owner_id).notes++; });
  contactsCreated.forEach((c) => { userEntry(c.properties?.hubspot_owner_id).contacts++; });
  companiesCreated.forEach((c) => { userEntry(c.properties?.hubspot_owner_id).companies++; });

  const userRows = Object.values(userActivity)
    .map((u) => {
      const total = u.dealsCreated + u.stageChanges + u.tasks + u.calls +
                    u.emails + u.meetings + u.notes + u.contacts + u.companies;
      return { ...u, total };
    })
    .sort((a, b) => b.total - a.total);

  function userActivityTable(rows) {
    if (rows.length === 0) return `<tr><td><p style="color:${TEXT_MUTED};font-style:italic;font-family:'DM Sans',Arial,sans-serif;font-size:13px;padding:8px 0;">No activity recorded.</p></td></tr>`;

    const cols = [
      { key: 'dealsCreated', label: 'Deals' },
      { key: 'stageChanges', label: 'Stages' },
      { key: 'tasks',        label: 'Tasks' },
      { key: 'calls',        label: 'Calls' },
      { key: 'emails',       label: 'Emails' },
      { key: 'meetings',     label: 'Meetings' },
      { key: 'notes',        label: 'Notes' },
      { key: 'contacts',     label: 'Contacts' },
      { key: 'companies',    label: 'Cos.' },
    ];

    const thStyle = `padding:8px 6px;font-size:10px;font-weight:700;color:${TEXT_MUTED};text-align:center;text-transform:uppercase;letter-spacing:0.5px;font-family:'DM Sans',Arial,sans-serif;border-bottom:1px solid ${BORDER};white-space:nowrap;`;
    const thNameStyle = `padding:8px 12px;font-size:10px;font-weight:700;color:${TEXT_MUTED};text-align:left;text-transform:uppercase;letter-spacing:0.5px;font-family:'DM Sans',Arial,sans-serif;border-bottom:1px solid ${BORDER};`;
    const thTotalStyle = `padding:8px 6px;font-size:10px;font-weight:700;color:${BLACK};text-align:center;text-transform:uppercase;letter-spacing:0.5px;font-family:'DM Sans',Arial,sans-serif;border-bottom:1px solid ${BORDER};white-space:nowrap;`;

    const headerRow = `
      <tr style="background:${LIGHT_GRAY};">
        <th style="${thNameStyle}">User</th>
        ${cols.map((c) => `<th style="${thStyle}">${c.label}</th>`).join('')}
        <th style="${thTotalStyle}">Total</th>
      </tr>`;

    const dataRows = rows.map((u, i) => {
      const bg = i % 2 === 1 ? ROW_ALT : WHITE;
      const name = u.id === '__unassigned__'
        ? `<em style="color:#9CA3AF;font-family:'DM Sans',Arial,sans-serif;font-size:13px;">Unassigned</em>`
        : `<span style="font-weight:600;color:${TEXT_MAIN};font-family:'DM Sans',Arial,sans-serif;font-size:13px;">${ownerName(u.id)}</span>`;
      const dealValueStr = u.dealValue > 0 ? formatAmount(u.dealValue) : null;
      const nameSub = dealValueStr
        ? `<div style="font-size:11px;color:${TEXT_MUTED};margin-top:2px;font-family:'DM Sans',Arial,sans-serif;">${dealValueStr} deal value</div>`
        : '';

      const tdStyle = `padding:10px 6px;text-align:center;border-bottom:1px solid ${BORDER};font-family:'DM Sans',Arial,sans-serif;`;

      const dataCells = cols.map((c) => {
        const val = u[c.key];
        const cell = val
          ? `<span style="font-size:14px;font-weight:700;color:${BLACK};">${val}</span>`
          : `<span style="font-size:13px;color:#D1D5DB;">—</span>`;
        return `<td style="${tdStyle}">${cell}</td>`;
      }).join('');

      return `
        <tr style="background:${bg};">
          <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};">${name}${nameSub}</td>
          ${dataCells}
          <td style="${tdStyle}"><span style="font-size:14px;font-weight:700;color:${RED};">${u.total}</span></td>
        </tr>`;
    }).join('');

    return `
      <tr>
        <td style="padding-bottom:20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
            ${headerRow}
            ${dataRows}
          </table>
        </td>
      </tr>`;
  }

  // Deals created table
  const dealsCreatedRows = dealsCreated.map((d) => {
    const amount = formatAmount(d.properties?.amount);
    const pipeline = stageMap[d.properties?.dealstage]?.pipeline || '—';
    return [
      `<strong>${d.properties?.dealname || 'Unnamed Deal'}</strong>`,
      formatDateOnly(d.properties?.createdate),
      pipeline,
      stageName(d.properties?.dealstage) || '—',
      amount ? `<strong style="color:${BLACK};">${amount}</strong>` : '—',
      ownerName(d.properties?.hubspot_owner_id),
    ];
  });

  // Deal stage changes table
  const stageChangeRows = dealStageChanges.map((d) => [
    `<strong>${d.dealname || 'Unnamed Deal'}</strong>`,
    stageBadge(stageName(d.fromStage), stageName(d.toStage)),
    ownerName(d.hubspot_owner_id),
    formatDate(d.changedAt),
  ]);

  // Tasks completed table
  const tasksRows = tasksCompleted.map((t) => [
    `<strong>${t.properties?.hs_task_subject || 'Untitled Task'}</strong>`,
    t.properties?.hs_task_type || '—',
    formatDateOnly(t.properties?.hs_task_completion_date),
    formatDateOnly(t.properties?.hs_timestamp),
    ownerName(t.properties?.hubspot_owner_id),
  ]);

  // Calls logged table
  const callsRows = callsLogged.map((c) => {
    const duration = c.properties?.hs_call_duration;
    const durationStr = duration ? `${Math.round(duration / 60000)}m` : '—';
    return [
      `<strong>${c.properties?.hs_call_title || 'Call'}</strong>`,
      formatDate(c.properties?.hs_createdate),
      c.properties?.hs_call_direction || '—',
      durationStr,
      ownerName(c.properties?.hubspot_owner_id),
    ];
  });

  // Emails sent table
  const emailRows = emailsSent.map((e) => [
    `<strong>${e.properties?.hs_email_subject || 'No Subject'}</strong>`,
    e.properties?.hs_email_to_email || '—',
    badge(e.properties?.hs_email_status || 'SENT'),
    ownerName(e.properties?.hubspot_owner_id),
  ]);

  // Meetings table
  const meetingRows = meetingsBooked.map((m) => [
    `<strong>${m.properties?.hs_meeting_title || 'Meeting'}</strong>`,
    formatDate(m.properties?.hs_meeting_start_time),
    badge(m.properties?.hs_meeting_outcome || 'SCHEDULED', '#DCFCE7', SUCCESS),
    ownerName(m.properties?.hubspot_owner_id),
  ]);

  // Notes table
  const noteRows = notesAdded.map((n) => {
    const assoc = noteAssociations[n.id] || { contacts: [], deals: [] };
    return [
      truncate(n.properties?.hs_note_body, 100) || 'No content',
      assoc.contacts.length > 0 ? assoc.contacts.join(', ') : '—',
      assoc.deals.length > 0 ? assoc.deals.join(', ') : '—',
      ownerName(n.properties?.hubspot_owner_id),
    ];
  });

  // Contacts created table
  const contactRows = contactsCreated.map((c) => {
    const name = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(' ') || 'Unknown';
    return [
      `<strong>${name}</strong>`,
      c.properties?.email || '—',
      c.properties?.company || '—',
      formatDateOnly(c.properties?.createdate),
      ownerName(c.properties?.hubspot_owner_id),
    ];
  });

  // Companies created table
  const companyRows = companiesCreated.map((c) => [
    `<strong>${c.properties?.name || 'Unknown'}</strong>`,
    c.properties?.domain || '—',
    c.properties?.industry || '—',
    formatDateOnly(c.properties?.createdate),
    ownerName(c.properties?.hubspot_owner_id),
  ]);

  // Form submissions
  const formSubmissionRows = formsSubmitted.flatMap((form) =>
    form.submissions.map((sub) => {
      const vals = Object.fromEntries((sub.values || []).map((v) => [v.name, v.value]));
      const email = vals.email || vals.EMAIL || '—';
      const firstName = vals.firstname || vals.FIRSTNAME || vals.first_name || '';
      const lastName = vals.lastname || vals.LASTNAME || vals.last_name || '';
      const name = [firstName, lastName].filter(Boolean).join(' ') || '—';
      const pageUrl = sub.pageUrl ? truncate(sub.pageUrl, 50) : '—';
      return [
        `<strong>${form.formName}</strong>`,
        formatDate(new Date(sub.submittedAt).toISOString()),
        email,
        name,
        pageUrl,
      ];
    })
  );

  const errorsSection = errors && errors.length > 0 ? `
    <tr>
      <td style="padding:14px 16px;background:#FEF2F2;border-radius:8px;margin-top:20px;border-left:4px solid ${DANGER};">
        <p style="color:${DANGER};font-weight:700;font-family:'DM Sans',Arial,sans-serif;font-size:13px;margin:0 0 8px 0;">Some data could not be retrieved:</p>
        <ul style="color:${TEXT_MUTED};font-size:12px;font-family:'DM Sans',Arial,sans-serif;margin:0;padding-left:16px;">
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
<body style="margin:0;padding:0;background:${LIGHT_GRAY};font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${LIGHT_GRAY};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:${BLACK};border-radius:10px 10px 0 0;padding:28px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:11px;font-weight:700;color:${RED};letter-spacing:0.1em;text-transform:uppercase;font-family:'DM Sans',Arial,sans-serif;margin-bottom:8px;">Daily Report</div>
                    <div style="font-size:24px;font-weight:700;color:${WHITE};font-family:'Syne',Arial,sans-serif;letter-spacing:-0.025em;line-height:1.2;">
                      HubSpot Activity Digest
                    </div>
                    <div style="font-size:13px;color:#9CA3AF;margin-top:6px;font-family:'DM Sans',Arial,sans-serif;">
                      ${dateRange}
                    </div>
                  </td>
                  <td align="right" valign="middle" style="padding-left:20px;">
                    <div style="display:inline-block;background:${RED};color:${WHITE};font-size:13px;font-weight:700;padding:6px 16px;border-radius:4px;font-family:'DM Sans',Arial,sans-serif;white-space:nowrap;">
                      ${totalActivities} ${totalActivities === 1 ? 'Activity' : 'Activities'}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Red accent bar -->
          <tr><td style="height:3px;background:${RED};"></td></tr>

          <!-- Body -->
          <tr>
            <td style="background:${WHITE};padding:28px 32px;border-radius:0 0 10px 10px;border:1px solid ${BORDER};border-top:none;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">

                ${noActivity ? `
                <tr>
                  <td style="text-align:center;padding:48px 0;">
                    <div style="font-size:13px;font-weight:700;color:${TEXT_MUTED};text-transform:uppercase;letter-spacing:0.1em;font-family:'DM Sans',Arial,sans-serif;">No Activity</div>
                    <p style="color:${TEXT_MUTED};font-size:15px;font-family:'DM Sans',Arial,sans-serif;margin-top:8px;">No HubSpot activity was recorded in this period.</p>
                  </td>
                </tr>` : `

                <!-- Summary Cards Row 1 -->
                <tr>
                  <td style="padding-bottom:6px;">
                    <div style="font-size:11px;font-weight:700;color:${TEXT_MUTED};text-transform:uppercase;letter-spacing:0.6px;font-family:'DM Sans',Arial,sans-serif;margin-bottom:10px;">Activity Summary</div>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>${summaryRow1.map((s) => summaryCard(s.label, s.count)).join('')}</tr>
                      <tr>${summaryRow2.map((s) => summaryCard(s.label, s.count)).join('')}</tr>
                      <tr>
                        ${summaryRow3.map((s) => summaryCard(s.label, s.count)).join('')}
                        <td style="width:25%;padding:6px;"></td>
                        <td style="width:25%;padding:6px;"></td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Divider -->
                <tr><td style="height:24px;border-bottom:1px solid ${BORDER};"></td></tr>
                <tr><td style="height:4px;"></td></tr>

                <!-- Activity by User -->
                ${sectionHeader('Activity by User', userRows.length)}
                ${userActivityTable(userRows)}

                <!-- Divider -->
                <tr><td style="height:4px;border-bottom:1px solid ${BORDER};"></td></tr>
                <tr><td style="height:4px;"></td></tr>

                <!-- Ad Leads -->
                ${adLeads.length > 0 ? `
                ${sectionHeader('Ad Leads', adLeads.length)}
                <tr>
                  <td style="padding-bottom:14px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        ${Object.entries(adLeadsByPlatform).map(([platform, count]) => `
                        <td style="padding-right:8px;">
                          <span style="display:inline-block;background:${LIGHT_GRAY};border:1px solid ${BORDER};border-radius:4px;padding:4px 12px;font-size:12px;font-family:'DM Sans',Arial,sans-serif;">
                            <span style="font-weight:700;color:${BLACK};">${count}</span>
                            <span style="color:${TEXT_MUTED};margin-left:4px;">${platform}</span>
                          </span>
                        </td>`).join('')}
                      </tr>
                    </table>
                  </td>
                </tr>
                ${activityTable(
                  ['Name', 'Email', 'Company', 'Platform', 'Campaign', 'Created'],
                  adLeadRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Deals Created -->
                ${dealsCreated.length > 0 ? `
                ${sectionHeader('Deals Created', dealsCreated.length)}
                ${dealsCreated.length >= BULK_THRESHOLD
                  ? bulkSummaryBlock(dealsCreated.length, 'deal')
                  : activityTable(['Deal Name', 'Created', 'Pipeline', 'Stage', 'Amount', 'Owner'], dealsCreatedRows, previewUrl, showAll)
                }` : ''}

                <!-- Deal Stage Changes -->
                ${dealStageChanges.length > 0 ? `
                ${sectionHeader('Deal Stage Changes', dealStageChanges.length)}
                ${activityTable(
                  ['Deal Name', 'Stage Transition', 'Owner', 'Changed At'],
                  stageChangeRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Tasks Completed -->
                ${tasksCompleted.length > 0 ? `
                ${sectionHeader('Tasks Completed', tasksCompleted.length)}
                ${activityTable(
                  ['Task Subject', 'Type', 'Completed At', 'Due Date', 'Owner'],
                  tasksRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Calls Logged -->
                ${callsLogged.length > 0 ? `
                ${sectionHeader('Calls Logged', callsLogged.length)}
                ${callsByOwnerChart(callsLogged, ownerMap, dispositionMap)}
                ${activityTable(
                  ['Title', 'Time', 'Direction', 'Duration', 'Owner'],
                  callsRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Emails Sent -->
                ${emailsSent.length > 0 ? `
                ${sectionHeader('Emails Sent', emailsSent.length)}
                ${activityTable(
                  ['Subject', 'To', 'Status', 'Owner'],
                  emailRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Meetings Booked -->
                ${meetingsBooked.length > 0 ? `
                ${sectionHeader('Meetings Booked', meetingsBooked.length)}
                ${activityTable(
                  ['Title', 'Start Time', 'Outcome', 'Owner'],
                  meetingRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Notes Added -->
                ${notesAdded.length > 0 ? `
                ${sectionHeader('Notes Added', notesAdded.length)}
                ${activityTable(
                  ['Note Preview', 'Contact', 'Deal', 'Owner'],
                  noteRows,
                  previewUrl,
                  showAll
                )}` : ''}

                <!-- Contacts Created -->
                ${contactsCreated.length > 0 ? `
                ${sectionHeader('Contacts Created', contactsCreated.length)}
                ${contactsCreated.length >= BULK_THRESHOLD
                  ? bulkSummaryBlock(contactsCreated.length, 'contact')
                  : activityTable(['Name', 'Email', 'Company', 'Created', 'Owner'], contactRows, previewUrl, showAll)
                }` : ''}

                <!-- Companies Created -->
                ${companiesCreated.length > 0 ? `
                ${sectionHeader('Companies Created', companiesCreated.length)}
                ${companiesCreated.length >= BULK_THRESHOLD
                  ? bulkSummaryBlock(companiesCreated.length, 'company')
                  : activityTable(['Company Name', 'Domain', 'Industry', 'Created', 'Owner'], companyRows, previewUrl, showAll)
                }` : ''}

                <!-- Form Submissions -->
                ${totalFormSubmissions > 0 ? `
                ${sectionHeader('Form Submissions', totalFormSubmissions)}
                ${activityTable(
                  ['Form', 'Submitted At', 'Email', 'Name', 'Page'],
                  formSubmissionRows,
                  previewUrl,
                  showAll
                )}` : ''}

                `}

                <!-- Errors -->
                ${errorsSection}

                <!-- Footer -->
                <tr>
                  <td style="padding-top:28px;border-top:1px solid ${BORDER};text-align:center;">
                    <div style="display:inline-block;margin-bottom:12px;">
                      <span style="font-size:13px;font-weight:700;color:${BLACK};font-family:'Syne',Arial,sans-serif;letter-spacing:-0.025em;">Aero</span><span style="font-size:13px;font-weight:700;color:${RED};font-family:'Syne',Arial,sans-serif;letter-spacing:-0.025em;">Rev</span>
                    </div>
                    <p style="color:${TEXT_MUTED};font-size:11px;font-family:'DM Sans',Arial,sans-serif;margin:0;line-height:1.6;">
                      Automated daily digest &bull; Powered by HubSpot CRM<br>
                      <span style="opacity:0.7;">To update recipients, edit your tenant settings in the admin dashboard.</span>
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
