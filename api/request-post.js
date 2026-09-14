// Vercel serverless function (Node runtime, zero-config: any file under /api
// is deployed automatically, no framework or build step required).
//
// Receives a "write a post about ___" request from blog.html's form and
// emails it via Resend (https://resend.com). Requires one environment
// variable, set in the Vercel project's dashboard:
//
//   RESEND_API_KEY   your Resend API key
//
// The destination address is hardcoded below since it isn't a secret.

const TO_EMAIL = 'liameggs+blog@ucla.edu';
const MAX_LEN = 2000;

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    const { topic, email, company } = req.body || {};

    // Honeypot: real visitors never fill this hidden field in.
    if (typeof company === 'string' && company.trim()) {
        return res.status(200).json({ ok: true });
    }

    if (typeof topic !== 'string' || !topic.trim()) {
        return res.status(400).json({ error: "Please describe what you'd like a post about." });
    }
    if (topic.length > MAX_LEN) {
        return res.status(400).json({ error: 'That request is a bit long — try trimming it down.' });
    }
    if (email && (typeof email !== 'string' || email.length > 320)) {
        return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.error('request-post: RESEND_API_KEY is not set');
        return res.status(500).json({ error: 'Request handling isn\'t configured yet — try emailing instead.' });
    }

    try {
        const trimmedTopic = topic.trim();
        const trimmedEmail = email && email.trim() ? email.trim() : null;
        const safeTopic = escapeHtml(trimmedTopic).replace(/\n/g, '<br>');
        const safeEmail = trimmedEmail ? escapeHtml(trimmedEmail) : null;

        const payload = {
            from: 'onboarding@resend.dev',
            to: TO_EMAIL,
            subject: 'New blog post request',
            text: `Someone requested a post via the blog:\n\n${trimmedTopic}\n\n` +
                (trimmedEmail ? `They'd like a reply at: ${trimmedEmail}` : '(no reply email given)'),
            html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background-color: #f6f6f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 8px; border: 1px solid #e5e5e5;">
    <tr>
      <td style="background-color: #111111; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <span style="color: #ffffff; font-size: 16px; font-weight: 600;">New blog post request</span>
      </td>
    </tr>
    <tr>
      <td style="padding: 24px;">
        <p style="margin: 0 0 8px 0; color: #666666; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Topic</p>
        <p style="margin: 0 0 20px 0; color: #111111; font-size: 15px; line-height: 1.5;">${safeTopic}</p>
        <p style="margin: 0 0 8px 0; color: #666666; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Reply to</p>
        <p style="margin: 0; color: #111111; font-size: 15px;">${safeEmail
                    ? `<a href="mailto:${safeEmail}" style="color: #2563eb; text-decoration: none;">${safeEmail}</a>`
                    : '<span style="color: #999999;">(no reply email given)</span>'}</p>
      </td>
    </tr>
  </table>
</div>`.trim()
        };
        if (trimmedEmail) payload.reply_to = trimmedEmail;

        const resendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!resendRes.ok) {
            const body = await resendRes.text().catch(() => '');
            console.error('request-post: Resend error', resendRes.status, body);
            return res.status(502).json({ error: 'Could not send the request right now — try again later.' });
        }

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('request-post: unexpected error', err);
        return res.status(500).json({ error: 'Something went wrong — try again later.' });
    }
}
