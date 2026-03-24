'use strict';

const { Resend } = require('resend');

function createClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is required');
  }
  return new Resend(apiKey);
}

async function sendEmail({ toEmails, subject, htmlBody }) {
  const resend = createClient();
  const fromEmail = process.env.FROM_EMAIL;
  const fromName = process.env.FROM_NAME || 'HubSpot Digest';

  if (!fromEmail) {
    throw new Error('FROM_EMAIL environment variable is required');
  }

  for (const to of toEmails) {
    await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html: htmlBody,
    });
    console.log(`  Email sent to ${to}`);
  }
}

module.exports = { sendEmail };
