/**
 * The emails Wuzie sends, on one layout that matches the app: the logo's black band with the wordmark, a white
 * card on the light ground, and the logo's orange only on the one action (the dashboard's 60-30-10).
 *
 * Email clients are not browsers: tables for layout, inline styles, no web fonts, no images (often blocked, and
 * the wordmark is text anyway), light colours forced so a dark-mode client does not invert the brand. Every email
 * has a plain-text twin. Anything a visitor typed is escaped.
 */

const C = {
    ground: '#f7f7f9',
    card: '#ffffff',
    band: '#111111',
    orange: '#ed7e25',
    ink: '#0d0d11',
    text: '#1a1a20',
    muted: '#64646f',
    sunken: '#f1f1f5',
    line: '#e6e6ec',
};
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Label/value rows on a sunken panel: a lead's details, or sign-in details. Values are escaped here. */
function details(rows, { mono = [] } = {}) {
    const cells = rows.filter(([, v]) => v).map(([label, value]) => `
        <tr>
          <td style="padding:8px 0;width:120px;vertical-align:top;font:14px/1.5 ${FONT};color:${C.muted};">${esc(label)}</td>
          <td style="padding:8px 0;vertical-align:top;font:${mono.includes(label) ? `15px/1.5 Consolas,Menlo,monospace` : `15px/1.5 ${FONT}`};color:${C.ink};word-break:break-word;">${esc(value).replace(/\n/g, '<br>')}</td>
        </tr>`).join('');
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background:${C.sunken};border-radius:14px;">
        <tr><td style="padding:12px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells}</table></td></tr>
      </table>`;
}

/** The one action, as a "bulletproof" button: a filled table cell, so Outlook draws it too. */
function button(label, url) {
    if (!url) return '';
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;">
        <tr><td style="border-radius:999px;background:${C.orange};">
          <a href="${esc(url)}" style="display:inline-block;padding:14px 28px;font:600 15px/1 ${FONT};color:${C.ink};text-decoration:none;border-radius:999px;">${esc(label)}</a>
        </td></tr>
      </table>`;
}

/** The plain-text twin of a line of email HTML: tags dropped, escapes undone. */
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const para = (html) => `<p style="margin:0 0 16px;font:16px/1.6 ${FONT};color:${C.text};">${html}</p>`;

/** Steps in order, so a real numbered list. */
const steps = (items) => `
  <ol style="margin:8px 0 0;padding:0 0 0 20px;font:15px/1.6 ${FONT};color:${C.text};">
    ${items.map((item) => `<li style="margin:0 0 8px;">${item}</li>`).join('')}
  </ol>`;

/**
 * The frame every email shares. `preheader` is the grey line inbox lists show after the subject; it is hidden in
 * the email itself.
 */
function layout({ preheader, heading, body, footnote }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ground};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="background:${C.band};border-radius:20px 20px 0 0;padding:22px 32px;">
        <span style="display:inline-block;width:12px;height:12px;margin-right:9px;border-radius:4px 4px 4px 1px;background:${C.orange};"></span><span style="font:600 24px/1 ${FONT};letter-spacing:-0.6px;color:#ffffff;">wuzie</span>
      </td></tr>
      <tr><td style="background:${C.card};border-radius:0 0 20px 20px;padding:36px 32px 32px;">
        <h1 style="margin:0 0 20px;font:600 24px/1.3 ${FONT};letter-spacing:-0.3px;color:${C.ink};">${esc(heading)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:20px 32px 0;font:13px/1.6 ${FONT};color:${C.muted};">
        ${footnote ? `${footnote}<br>` : ''}Wuzie: bulk WhatsApp messaging from your own number.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** A line the Wuzie team typed: escaped, with web addresses made clickable (only http(s), so never a script link). */
const linked = (line) => line.split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,!?)])/)
    .map((part, i) => (i % 2 ? `<a href="${esc(part)}" style="color:${C.ink};">${esc(part)}</a>` : esc(part))).join('');

/** An email written on the dashboard, already filled in for one person: a blank line starts a new paragraph. */
export function customEmail({ subject, body }) {
    const html = layout({
        preheader: body.split('\n')[0],
        heading: subject,
        body: body.split(/\n\s*\n/).map((p) => para(p.split('\n').map(linked).join('<br>'))).join(''),
        footnote: 'You get this because you have a Wuzie account or asked for one. Reply to this email if you would rather not get these.',
    });
    return { subject, html, text: body };
}

/** To the visitor, right after they ask for an account. */
export function leadReceivedEmail(lead) {
    const first = String(lead.name).trim().split(/\s+/)[0] || 'there';
    return {
        subject: 'We got your request for Wuzie',
        html: layout({
            preheader: `We will email your sign-in details for ${lead.business} within one working day.`,
            heading: `Thanks, ${first}`,
            body: `
              ${para(`We have your request for <strong>${esc(lead.business)}</strong>. A person reads every request, and we reply to this address within one working day.`)}
              <p style="margin:24px 0 0;font:600 15px/1.5 ${FONT};color:${C.ink};">What happens next</p>
              ${steps([
                  'We set up your workspace on the plan that fits.',
                  'We email you your sign-in details.',
                  'You scan one QR code to link your WhatsApp number and send your first campaign.',
              ])}`,
            footnote: 'You get this email because this address asked for a Wuzie account. Not you? Ignore it and nothing happens.',
        }),
        text: [
            `Thanks, ${first}`,
            '',
            `We have your request for ${lead.business}. A person reads every request, and we reply to this address within one working day.`,
            '',
            'What happens next',
            '1. We set up your workspace on the plan that fits.',
            '2. We email you your sign-in details.',
            '3. You scan one QR code to link your WhatsApp number and send your first campaign.',
        ].join('\n'),
    };
}

/** To the platform's inbox: someone asked for an account. Reply-to is the visitor, so "Reply" reaches them. */
export function leadAlertEmail(lead, leadsUrl) {
    const rows = [
        ['Name', lead.name],
        ['Business', lead.business],
        ['Email', lead.email],
        ['WhatsApp', lead.phone],
        ['They will send', lead.message],
        ['From', lead.source === 'login' ? 'The sign-in page' : 'The landing page'],
    ];
    return {
        subject: `New account request: ${lead.business}`,
        html: layout({
            preheader: `${lead.name} from ${lead.business} asked for an account.`,
            heading: 'New account request',
            body: `
              ${para(`<strong>${esc(lead.name)}</strong> from <strong>${esc(lead.business)}</strong> asked for an account. Reply to this email to write to them.`)}
              ${details(rows)}
              ${button('Open leads', leadsUrl)}`,
            footnote: 'Convert the request from Leads to create the business and its owner.',
        }),
        text: [
            'New account request',
            '',
            ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
            ...(leadsUrl ? ['', `Open leads: ${leadsUrl}`] : []),
        ].join('\n'),
    };
}

/** To a new business owner: their workspace is ready, with the sign-in details the admin just created. */
export function welcomeEmail({ name, business, planName, email, password, loginUrl }) {
    const first = String(name ?? '').trim().split(/\s+/)[0] || 'there';
    return {
        subject: 'Your Wuzie account is ready',
        html: layout({
            preheader: `Sign in to ${business} on Wuzie.`,
            heading: `Welcome to Wuzie, ${first}`,
            body: `
              ${para(`Your workspace for <strong>${esc(business)}</strong> is ready${planName ? ` on the <strong>${esc(planName)}</strong> plan` : ''}. Here is how to sign in:`)}
              ${details([['Email', email], ['Password', password]], { mono: ['Password'] })}
              ${para('After you sign in, change the password: open the account button at the bottom of the sidebar.')}
              ${button('Sign in', loginUrl)}`,
            footnote: 'Keep this email private: it holds your password until you change it.',
        }),
        text: [
            `Welcome to Wuzie, ${first}`,
            '',
            `Your workspace for ${business} is ready${planName ? ` on the ${planName} plan` : ''}.`,
            '',
            `Email: ${email}`,
            `Password: ${password}`,
            ...(loginUrl ? [`Sign in: ${loginUrl}`] : []),
            '',
            'After you sign in, change the password: open the account button at the bottom of the sidebar.',
        ].join('\n'),
    };
}

/**
 * What each account event says by email (the same events Wuzie's WhatsApp number sends, platform/notify.js), in
 * the owner's words: what happened, the facts to keep, and how to reply. Account-ready and request-received have
 * their own emails above, so they are not here. `vars` are notifyTenant's: name, business, plan, amount, date...
 */
const cap = (word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word);

const ACCOUNT_EMAILS = {
    plan_started: (v) => ({
        subject: `Your ${v.plan} plan is confirmed`,
        heading: 'Your plan is confirmed',
        intro: `<strong>${esc(v.business)}</strong> is now on the <strong>${esc(v.plan)}</strong> plan. Keep these details for your records.`,
        rows: [['Plan', v.plan], ['Business', v.business], ['Amount', v.amount], ['Billing', cap(v.billing)], ['Renews on', v.date]],
        footnote: 'You get this email because your business uses Wuzie.',
    }),
    plan_renewed: (v) => ({
        subject: `Your ${v.plan} plan is renewed`,
        heading: 'Plan renewed',
        intro: `Thank you for staying with us. The <strong>${esc(v.plan)}</strong> plan for <strong>${esc(v.business)}</strong> is renewed.`,
        rows: [['Plan', v.plan], ['Amount', v.amount], ['Billing', cap(v.billing)], ['Next renewal', v.date]],
        footnote: 'You get this email because your business uses Wuzie.',
    }),
    topup_added: (v) => ({
        subject: `We added ${v.topup} to ${v.business}`,
        heading: 'Top-up added',
        intro: `We added <strong>${esc(v.topup)}</strong> to <strong>${esc(v.business)}</strong>.`,
        rows: [['Added', v.topup], ['Amount', v.amount], ['Plan runs until', v.date]],
        footnote: 'You get this email because your business uses Wuzie.',
    }),
    payment_received: (v) => ({
        subject: `Payment received: ${v.amount}`,
        heading: 'Payment received',
        intro: `Thank you. We received <strong>${esc(v.amount)}</strong> for <strong>${esc(v.business)}</strong>.`,
        rows: [['Amount', v.amount], ['Business', v.business], ['Received on', v.today], ['Still due', v.due]],
        footnote: 'Keep this email as your receipt.',
    }),
    plan_ending: (v) => ({
        subject: `Your ${v.plan} plan ends on ${v.date}`,
        heading: `${v.days} ${v.days === 1 ? 'day' : 'days'} left on your plan`,
        intro: `The <strong>${esc(v.plan)}</strong> plan for <strong>${esc(v.business)}</strong> ends on <strong>${esc(v.date)}</strong>. Reply to this email to renew, and nothing stops.`,
        rows: [['Plan', v.plan], ['Ends on', v.date]],
        footnote: 'Reply to this email and it reaches the Wuzie team.',
    }),
    plan_expired: (v) => ({
        subject: `Your ${v.plan} plan has ended`,
        heading: 'Your plan has ended',
        intro: `The <strong>${esc(v.plan)}</strong> plan for <strong>${esc(v.business)}</strong> ended on <strong>${esc(v.date)}</strong>. You can still sign in and see everything; sending pauses after 7 days of grace. Reply to this email to renew.`,
        rows: [['Plan', v.plan], ['Ended on', v.date]],
        footnote: 'Reply to this email and it reaches the Wuzie team.',
    }),
};

/** The email for one account event, or null for an event that has none. */
export function accountEmail(kind, vars, appUrl) {
    const make = ACCOUNT_EMAILS[kind];
    if (!make) return null;
    const first = String(vars.name ?? '').trim().split(/\s+/)[0] || 'there';
    const { subject, heading, intro, rows, footnote } = make(vars);
    return {
        subject,
        html: layout({
            preheader: subject,
            heading,
            body: `
              ${para(`Hi ${esc(first)},`)}
              ${para(intro)}
              ${details(rows)}
              ${button('Open Wuzie', appUrl && `${appUrl}/login`)}`,
            footnote,
        }),
        text: [
            `Hi ${first},`,
            '',
            plain(intro),
            '',
            ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
            ...(appUrl ? ['', `Open Wuzie: ${appUrl}/login`] : []),
        ].join('\n'),
    };
}

/** To a new member of the platform staff (Settings > Roles & staff): their sign-in and what their role opens. */
export function staffWelcomeEmail({ name, roleName, email, password, loginUrl }) {
    const first = String(name ?? '').trim().split(/\s+/)[0] || 'there';
    return {
        subject: 'Your Wuzie staff sign-in',
        html: layout({
            preheader: `You can now sign in to Wuzie as ${roleName}.`,
            heading: `Welcome to the team, ${first}`,
            body: `
              ${para(`You can now sign in to the Wuzie platform as <strong>${esc(roleName)}</strong>. Your role decides which pages you see.`)}
              ${details([['Email', email], ['Password', password], ['Role', roleName]], { mono: ['Password'] })}
              ${para('Ask the platform admin if you need a page your role does not open.')}
              ${button('Sign in', loginUrl)}`,
            footnote: 'Keep this email private: it holds your password.',
        }),
        text: [
            `Welcome to the team, ${first}`,
            '',
            `You can now sign in to the Wuzie platform as ${roleName}.`,
            '',
            `Email: ${email}`,
            `Password: ${password}`,
            `Role: ${roleName}`,
            ...(loginUrl ? [`Sign in: ${loginUrl}`] : []),
        ].join('\n'),
    };
}

const SAMPLE = {
    name: 'Priya Shah', business: 'Sunrise Traders', email: 'priya@example.com', plan: 'Business', amount: '₹2,999',
    billing: 'monthly', date: '12 Dec 2026', today: '12 Nov 2026', topup: '5,000 messages', due: '₹0', days: 3,
};
const SAMPLE_LEAD = { ...SAMPLE, phone: '+91 98200 11234', message: 'Diwali offers to our customers', source: 'landing' };
const SAMPLE_LOGIN = { ...SAMPLE, planName: SAMPLE.plan, password: 'sample-password' };
const OWNER = 'The business owner';

/**
 * Every email Wuzie sends by itself, in the order a client meets them, with a sample to preview. A new automatic
 * email belongs here, or the Wuzie Email page does not show it.
 */
export const AUTOMATIC_EMAILS = Object.freeze([
    {
        kind: 'lead_received', label: 'Request received', when: 'Someone fills in the "Ask for your account" form.', to: 'The person who asked',
        sample: () => leadReceivedEmail(SAMPLE_LEAD),
    },
    {
        kind: 'lead_alert', label: 'New request alert', when: 'Someone fills in the "Ask for your account" form.', to: 'Your team',
        sample: (appUrl) => leadAlertEmail(SAMPLE_LEAD, appUrl && `${appUrl}/admin/leads`),
    },
    {
        kind: 'welcome', label: 'Account ready', when: 'You activate a business and choose to send its sign-in details.', to: OWNER,
        sample: (appUrl) => welcomeEmail({ ...SAMPLE_LOGIN, loginUrl: appUrl && `${appUrl}/login` }),
    },
    { kind: 'plan_started', label: 'Plan active', when: 'A business is put on a new plan.', to: OWNER, sample: (appUrl) => accountEmail('plan_started', SAMPLE, appUrl) },
    { kind: 'plan_renewed', label: 'Plan renewed', when: 'A business renews the plan it is on.', to: OWNER, sample: (appUrl) => accountEmail('plan_renewed', SAMPLE, appUrl) },
    { kind: 'topup_added', label: 'Top-up added', when: 'Days or messages are topped up.', to: OWNER, sample: (appUrl) => accountEmail('topup_added', SAMPLE, appUrl) },
    { kind: 'payment_received', label: 'Payment received', when: 'You record a payment.', to: OWNER, sample: (appUrl) => accountEmail('payment_received', SAMPLE, appUrl) },
    { kind: 'plan_ending', label: 'Plan expires soon', when: '3 days before a plan or trial ends.', to: OWNER, sample: (appUrl) => accountEmail('plan_ending', SAMPLE, appUrl) },
    { kind: 'plan_expired', label: 'Plan expired', when: 'The day a plan or trial ends.', to: OWNER, sample: (appUrl) => accountEmail('plan_expired', SAMPLE, appUrl) },
    {
        kind: 'staff_welcome', label: 'Staff sign-in', when: 'You add someone to your platform staff.', to: 'The new staff member',
        sample: (appUrl) => staffWelcomeEmail({ ...SAMPLE_LOGIN, roleName: 'Support', loginUrl: appUrl && `${appUrl}/login` }),
    },
]);
