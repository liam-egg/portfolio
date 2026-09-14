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
        const payload = {
            from: 'ansatz blog requests <onboarding@resend.dev>',
            to: TO_EMAIL,
            subject: 'New blog post request',
            text: `Someone requested a post via the blog:\n\n${topic.trim()}\n\n` +
                (email ? `They'd like a reply at: ${email.trim()}` : '(no reply email given)')
        };
        if (email && email.trim()) payload.reply_to = email.trim();

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
