'use strict';

const nodemailer = require('nodemailer');

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables are required');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendEmail({ toEmails, subject, htmlBody }) {
  const transporter = createTransporter();
  const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
  const fromName = process.env.FROM_NAME || 'HubSpot Digest';

  for (const to of toEmails) {
    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      html: htmlBody,
    });
    console.log(`  Email sent to ${to}`);
  }
}

module.exports = { sendEmail };
