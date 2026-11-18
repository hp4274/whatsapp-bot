import type { Guide } from '../guides';

export const developer: Guide = {
  title: 'API & Webhooks guide',
  intro: 'Connect your own systems with API keys and get told about activity with webhooks.',
  tasks: [
    {
      title: 'Create an API key',
      steps: [
        'Open API & Webhooks and go to API keys.',
        'Give the key a Name, for example ERP integration.',
        'Pick an Expires on date, or leave it empty for the longest allowed.',
        'Tick only the Scopes your system needs, then click Create key.',
        'Click Copy and store the key somewhere safe, then click Done.',
      ],
      tip: 'You will not see the key again after you click Done.',
    },
    {
      title: 'Replace or revoke a key',
      steps: [
        'Each key shows when it was created, last used and when it expires.',
        'A key marked Expires soon needs a replacement: create a new one and switch your system to it.',
        'Click Revoke, then Yes, revoke to stop the old key working for good.',
      ],
    },
    {
      title: 'Add a webhook endpoint',
      steps: [
        'Under Webhooks, type your Endpoint URL.',
        'Tick the Events you want to hear about.',
        'Click Add endpoint.',
        'Copy the signing secret shown, then click Done.',
      ],
      tip: 'Use the signing secret to check the X-Webhook-Signature header, so you know the call came from us.',
    },
    {
      title: 'Change, pause or delete a webhook',
      steps: [
        'Click Edit events on an endpoint, change the ticks and click Save.',
        'Click Pause to stop sending to it for now, and Resume to start again.',
        'Click Delete, then Yes, delete to remove it.',
      ],
    },
    {
      title: 'Check webhook deliveries',
      steps: [
        'Click Recent deliveries under an endpoint.',
        'Each line shows the response code or status, the event, the time and how many attempts it took.',
        'Failed deliveries show the error, to help you fix your endpoint.',
      ],
    },
    {
      title: 'Make your first API call',
      steps: [
        'Scroll to Quick start and click Copy to copy the sample command.',
        'Replace <your-api-key> with your key and run it to send an event that can start your workflows.',
        'Endpoints lists what you can call and which scope each one needs.',
      ],
      tip: 'Send the same Idempotency-Key again to retry safely without doing it twice.',
    },
  ],
};
