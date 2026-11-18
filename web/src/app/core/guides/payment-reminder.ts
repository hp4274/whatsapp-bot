import type { Guide } from '../guides';

export const paymentReminder: Guide = {
  title: 'Payment Reminder guide',
  intro: 'Remind customers about money they owe and track who has paid. Keep this open while you work.',
  tasks: [
    {
      title: 'Import dues from Excel',
      steps: [
        'Open Payment Reminder and scroll to Import dues.',
        'Click Import Excel and pick your file.',
        'The sheet needs a phone column (phone, mobile or number) and an amount column (remaining, payment_due or due_amount).',
        'You can also add name, due_date, invoice and message columns.',
        'Check the valid row count and open any row or file issues to see what was skipped.',
      ],
      tip: 'Repeated rows are skipped automatically.',
    },
    {
      title: 'Send reminders now',
      steps: [
        'Import your Excel file under Import dues.',
        'Check the messages under Imported rows - First preview shows what the first customer gets.',
        'Look at Daily budget to see how many you can still send today.',
        'Click Send payment reminders.',
      ],
      tip: 'Reminders over today\'s limit stay queued and go out when the budget resets.',
    },
    {
      title: 'Write the reminder message',
      steps: [
        'Under Message and UPI, write the Reminder message.',
        'Use {name}, {amount}, {due_date}, {invoice} and {upi_link} to fill in each customer\'s details.',
        'Check the Preview below the form.',
        'Click Save in the bar at the bottom.',
      ],
      tip: 'If your sheet has a message column, that row\'s own message is used instead.',
    },
    {
      title: 'Add a UPI pay link',
      steps: [
        'Under Message and UPI, type your UPI ID, for example yourname@okbank.',
        'Type the Name shown in the UPI app - usually your business name.',
        'Put {upi_link} in the message so customers can tap to pay.',
        'Click Save.',
      ],
    },
    {
      title: 'Turn on automatic reminders',
      steps: [
        'Under Automatic reminders, switch it On.',
        'Set Days before the due date (0 means none before).',
        'Choose whether to remind On the due date.',
        'Set Then every (days) and Follow-ups at most for reminders after the due date.',
        'Click Save in the bar at the bottom.',
      ],
      tip: 'Reminders go from 10 am until the due is paid. A customer who replies PAID is not reminded again until you check.',
    },
    {
      title: 'Track who still owes',
      steps: [
        'Under Dues, search by Name, phone or invoice.',
        'Use Open, Overdue, Says paid, Paid or All to filter the list.',
        'The Reminders column shows how many each customer has been sent.',
      ],
    },
    {
      title: 'Mark a due as paid',
      steps: [
        'Find the customer under Dues.',
        'Click Mark paid once the money arrives - they get no more reminders.',
        'If a customer replied PAID but you did not get it, click Not received to keep reminding them.',
      ],
      tip: 'Check Says paid often - those customers are waiting for you to confirm.',
    },
  ],
};
