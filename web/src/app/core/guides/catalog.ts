import type { Guide } from '../guides';

export const catalog: Guide = {
  title: 'WhatsApp Catalog guide',
  intro: 'See the catalog from your WhatsApp Business app and use it for orders.',
  tasks: [
    {
      title: 'Open your catalog',
      steps: [
        'Open WhatsApp Catalog. Each linked number is listed with its state.',
        'On a number marked WhatsApp Business, click Open catalog.',
        'Your products show with photos and prices; hidden ones are marked Hidden. Click a product to see all its photos and details.',
      ],
      tip: 'The catalog is made in the WhatsApp Business app: Settings, Business tools, Catalog.',
    },
    {
      title: 'Find a product',
      steps: [
        'In the open catalog, type in Search name or SKU.',
        'Click a collection chip to show only that collection, or All to show everything.',
        'Click Refresh after you change the catalog in the WhatsApp Business app.',
      ],
    },
    {
      title: 'Add catalog products to your Orders list',
      steps: [
        'In the open catalog, tick the products you want, or click Pick all shown.',
        'Click Add to my Orders list.',
        'Click Open Orders to see them under Your products in the On WhatsApp tab, photos included.',
      ],
      tip: 'Products already added before are skipped, so you can run it again safely.',
    },
    {
      title: 'Get orders from the WhatsApp cart',
      steps: [
        'Customers browse your catalog in WhatsApp, add products to their cart and send it to you.',
        'Each cart order becomes an order on the Orders page, and the customer is told you got it.',
      ],
    },
    {
      title: 'Unlock the catalog on a regular WhatsApp number',
      steps: [
        'A number marked Regular WhatsApp shows Unlock catalog - click it.',
        'Install the free WhatsApp Business app and move the number to it.',
        'Click Link a WhatsApp Business number and scan the new QR code.',
      ],
      tip: 'Linking again signs the number out here until the new code is scanned.',
    },
    {
      title: 'Fix a number that does not show its catalog',
      steps: [
        'If a number says This number is offline, click Connect it.',
        'If it says we could not tell yet if it is WhatsApp Business, click Open catalog to check.',
        'With no number linked yet, click Link a number.',
      ],
    },
  ],
};
