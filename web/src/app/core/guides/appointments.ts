import type { Guide } from '../guides';

export const appointments: Guide = {
  title: 'Appointments guide',
  intro: 'Keep your bookings in one place and take new ones on WhatsApp.',
  tasks: [
    {
      title: 'Add an appointment by hand',
      steps: [
        'Open Appointments and click New appointment.',
        'Under Customer, search your contacts by name or number and pick the person.',
        'Fill in Service and Scheduled at - both are needed. Add Duration minutes, Staff id, Location or Notes if you like.',
        'Leave Reference blank to get one made for you, and pick a Status.',
        'Click Create appointment.',
      ],
      tip: 'The customer must be in your contacts first. Add them on the Contacts page if the search finds no one.',
    },
    {
      title: 'Change, confirm or cancel an appointment',
      steps: [
        'Click the appointment in the list to open it.',
        'Change the Status - for example Confirmed, Rescheduled, Completed, Cancelled or No show - or any other detail.',
        'Click Save changes.',
        'If the customer has a WhatsApp number, they are told about the new status, and the panel says so.',
      ],
    },
    {
      title: 'See what happened to an appointment',
      steps: [
        'Open the appointment from the list.',
        'Scroll to Activity at the bottom of the panel.',
        'It lists when it was created, each status change and each edit, newest first.',
      ],
    },
    {
      title: 'Find an appointment',
      steps: [
        'Use the status chips (All, Scheduled, Confirmed...) to show one status; each chip shows its count.',
        'Type in Search appointments to find a reference, a name, a number or any detail.',
        'If nothing shows, click Clear filters.',
      ],
    },
    {
      title: 'Delete an appointment',
      steps: [
        'Open the appointment and click Delete.',
        'Click Delete again to confirm, or Keep to go back.',
      ],
      tip: 'Deleting cannot be undone. Setting the status to Cancelled keeps the record.',
    },
    {
      title: 'Take bookings on WhatsApp',
      steps: [
        'On Appointments, switch to the On WhatsApp tab.',
        'Add at least one service under Your services.',
        'Turn on the switch on Take bookings on WhatsApp.',
        'Customers send BOOK, pick a service by its number and send a time like tomorrow 11am.',
        'Try it: send BOOK to your own number from another phone.',
      ],
      tip: 'Until a service is added, customers are told your list is being updated.',
    },
    {
      title: 'Add or edit a service',
      steps: [
        'In On WhatsApp, under Your services, click Add service (or the pencil next to a service).',
        'Enter the Name and Price. Group and Short note are optional.',
        'Under Pictures, click Add picture for up to 5 JPG or PNG photos; the first one is the cover.',
        'Under Options, click Add option for different durations or prices, each with its own price.',
        'Click Add (or Save).',
      ],
      tip: 'With 2 or more services that have pictures, BOOK also sends a swipe carousel of the first 5.',
    },
    {
      title: 'Hide or delete a service',
      steps: [
        'Use the switch next to a service to hide it from customers without deleting it.',
        'Click the bin icon and confirm with Delete to remove it for good.',
        'Bookings that already have it keep it.',
      ],
    },
    {
      title: 'Take UPI payment for bookings',
      steps: [
        'In On WhatsApp, under Payment & details, enter your UPI ID and the Name on the account.',
        'Or click Or upload your QR image to send your own QR instead.',
        'Tick Ask for payment as soon as the booking is placed.',
        'Click Save.',
      ],
      tip: 'A QR with the exact amount is made for each booking. The customer replies PAID after paying.',
    },
    {
      title: 'Set reminders, alerts and business info',
      steps: [
        'Under Payment & details, set Remind the customer before to a number of hours (0 turns it off).',
        'Tick Message me on WhatsApp for each new booking and each "PAID" to get alerts.',
        'Add a Note after every booking and your Business info - it is sent when customers type INFO, ADDRESS or TIMINGS.',
        'Open Advanced to change the List heading or Currency.',
        'Click Save.',
      ],
    },
    {
      title: 'Handle bookings that came in on WhatsApp',
      steps: [
        'In On WhatsApp, scroll to Bookings, newest first.',
        'Pick a new status from the Status menu on a row.',
        'If the customer says they paid, the Payment shows Says paid - check. Check your bank, then click Mark paid.',
        'Each change messages the customer on WhatsApp.',
      ],
      tip: 'Customers can reply STATUS any time to check their bookings.',
    },
  ],
};
