import type { Guide } from '../guides';

export const otp: Guide = {
  title: 'WhatsApp OTP guide',
  intro: 'Send one-time login codes to your customers on WhatsApp from your own app.',
  tasks: [
    {
      title: 'Get started',
      steps: [
        'Open WhatsApp OTP and follow Get started.',
        'Link your WhatsApp number - click Link it now if it is not linked yet.',
        'Create an API key.',
        'Give the key and the code under For your developer to whoever builds your app.',
      ],
    },
    {
      title: 'Create an API key',
      steps: [
        'Under API keys, type a Name, for example Website login.',
        'Click Create key.',
        'Click Copy to copy the key, then Done.',
      ],
      tip: 'You will not see the key again, so keep it somewhere safe right away.',
    },
    {
      title: 'Stop a key from working',
      steps: [
        'Under API keys, click Revoke next to the key.',
        'Confirm with Revoke. Any app using it can no longer send codes.',
      ],
    },
    {
      title: 'Check which apps use your codes',
      steps: [
        'Look at Where your API is used.',
        'It lists every app and server that sent a code in the last 30 days, by key and address.',
        'If you do not recognise one, revoke its key.',
      ],
    },
    {
      title: 'Write the code message',
      steps: [
        'Under The message, set your Business name and write the Message.',
        'Tap {code}, {brand} or {minutes} to add them. The message must include {code}.',
        'Set the Code length, Expires after (minutes), Wrong tries allowed and Wait before resend (seconds).',
        'Check the preview and click Save.',
      ],
    },
    {
      title: 'Hand the setup to your developer',
      steps: [
        'Go to For your developer.',
        'Pick cURL, Node.js, Python or PHP and click Copy.',
        'Replace YOUR_API_KEY with a key from above.',
        'Errors lists what each error answer means.',
      ],
    },
    {
      title: 'Send yourself a test code',
      steps: [
        'Under Send a test, type a WhatsApp number and click Send code.',
        'Type the Code from WhatsApp and click Verify.',
        'The result shows whether the code was right.',
      ],
    },
    {
      title: 'See the codes you sent',
      steps: [
        'Recent codes lists each code with its number, status, purpose and where it came from.',
        'Status shows Waiting, Verified, Expired, Not sent or Blocked.',
        'Tries shows how many times the customer typed a code.',
      ],
    },
  ],
};
