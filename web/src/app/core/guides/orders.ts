import type { Guide } from '../guides';

export const orders: Guide = {
  title: 'Orders guide',
  intro: 'Track every order and let customers order from you on WhatsApp.',
  tasks: [
    {
      title: 'Add an order by hand',
      steps: [
        'Open Orders and click New order.',
        'Under Customer, search your contacts by name or number and pick the person.',
        'Enter the Amount - it is needed. Add Currency, Items, Tracking id, Delivery at or Notes if you like.',
        'Leave Reference blank to get one made for you, and pick a Status.',
        'Click Create order.',
      ],
      tip: 'The customer must be in your contacts first. Add them on the Contacts page if the search finds no one.',
    },
    {
      title: 'Move an order along',
      steps: [
        'Click the order in the list to open it.',
        'Change the Status - Placed, Confirmed, Processing, Shipped, Delivered, Cancelled or Refunded.',
        'Add a Tracking id or Delivery at if you have them.',
        'Click Save changes. If the customer has a WhatsApp number, they are told, and the panel says so.',
      ],
    },
    {
      title: 'See what happened to an order',
      steps: [
        'Open the order from the list.',
        'Scroll to Activity at the bottom of the panel.',
        'It lists when it was created, each status change and each edit, newest first.',
      ],
    },
    {
      title: 'Find an order',
      steps: [
        'Use the status chips (All, Placed, Shipped...) to show one status; each chip shows its count.',
        'Type in Search orders to find a reference, a name, a number or any detail.',
        'If nothing shows, click Clear filters.',
      ],
    },
    {
      title: 'Delete an order',
      steps: [
        'Open the order and click Delete.',
        'Click Delete again to confirm, or Keep to go back.',
      ],
      tip: 'Deleting cannot be undone. Setting the status to Cancelled keeps the record.',
    },
    {
      title: 'Take orders on WhatsApp',
      steps: [
        'On Orders, switch to the On WhatsApp tab.',
        'Add at least one product under Your products.',
        'Turn on the switch on Take orders on WhatsApp.',
        'Customers send MENU, add items by their number, then send CHECKOUT to place the order.',
        'Try it: send MENU to your own number from another phone.',
      ],
      tip: 'Customers can also send CART to see their cart, REMOVE 1 to take out line 1, or CLEAR to empty it.',
    },
    {
      title: 'Add or edit a product',
      steps: [
        'In On WhatsApp, under Your products, click Add product (or the pencil next to a product).',
        'Enter the Name and Price. Group and Short note are optional.',
        'Under Pictures, click Add picture for up to 5 JPG or PNG photos; the first one is the cover.',
        'Under Options, click Add option for sizes or flavours, each with its own price.',
        'Click Add (or Save).',
      ],
      tip: 'With 2 or more products that have pictures, MENU also sends a swipe carousel of the first 5.',
    },
    {
      title: 'Hide or delete a product',
      steps: [
        'Use the switch next to a product to hide it from customers without deleting it.',
        'Click the bin icon and confirm with Delete to remove it for good.',
        'Orders that already have it keep it.',
      ],
    },
    {
      title: 'Take UPI payment for orders',
      steps: [
        'In On WhatsApp, under Payment & details, enter your UPI ID and the Name on the account.',
        'Or click Or upload your QR image to send your own QR instead.',
        'Tick Ask for payment as soon as the order is placed.',
        'Click Save.',
      ],
      tip: 'A QR with the exact amount is made for each order. The customer replies PAID after paying.',
    },
    {
      title: 'Set delivery, alerts and business info',
      steps: [
        'Under Payment & details, tick Ask for a delivery address and set a Delivery charge if you charge one.',
        'Tick Message me on WhatsApp for each new order and each "PAID" to get alerts.',
        'Add a Note after every order and your Business info - it is sent when customers type INFO, ADDRESS or TIMINGS.',
        'Open Advanced to change the List heading or Currency.',
        'Click Save.',
      ],
    },
    {
      title: 'Handle orders that came in on WhatsApp',
      steps: [
        'In On WhatsApp, scroll to Orders, newest first.',
        'Pick a new status from the Status menu on a row.',
        'If the customer says they paid, the Payment shows Says paid - check. Check your bank, then click Mark paid.',
        'Each change messages the customer on WhatsApp.',
      ],
      tip: 'Customers can reply STATUS any time to check their orders.',
    },
    {
      title: 'Bring in products from your WhatsApp catalog',
      steps: [
        'If your number uses WhatsApp Business, open WhatsApp Catalog and click Open catalog.',
        'Pick the products and click Add to my Orders list.',
        'They show up under Your products in On WhatsApp, photos included.',
      ],
    },
  ],
};
