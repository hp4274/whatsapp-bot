import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** The WhatsApp message this feature puts on a customer's phone. */
export interface Said {
  readonly name: string;
  readonly text: string;
  readonly time: string;
}

/** The QR tile of How it works and of WhatsApp numbers: 9x9, with the three corner finder blocks a real code has. Decorative. */
export const QR: readonly number[] = [
  '111010111',
  '101001101',
  '111010111',
  '000110000',
  '101101101',
  '010010110',
  '111011010',
  '101001101',
  '111010111',
]
  .join('')
  .split('')
  .map(Number);

const SEAT_ROWS = ['A', 'B', 'C', 'D', 'E'];
const SEATS = SEAT_ROWS.flatMap((row, r) =>
  Array.from({ length: 12 }, (_, n) => {
    const id = `${row}${n + 1}`;
    return { id, state: id === 'B12' ? 'mine' : (r * 7 + n * 3) % 4 ? 'taken' : 'free' };
  }),
);

const API_CALL = `POST /api/v1/orders
Authorization: Bearer wz_live_...

{
  "reference": "4830",
  "phone": "919820011234",
  "status": "paid"
}`;

/**
 * What each feature looks like at work, each in the shape of its own job: a spreadsheet, a QR code, a receipt, a seat
 * map. Sample names and figures. Swapping the feature rebuilds the scene, so its parts play in again.
 */
@Component({
  selector: 'app-feature-scene',
  imports: [NgTemplateOutlet],
  templateUrl: './feature-scene.html',
  styleUrl: './feature-scene.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeatureScene {
  readonly key = input.required<string>();
  readonly said = input<Said | null>(null);

  protected readonly qr = QR;
  protected readonly seats = SEATS;
  protected readonly seatsBooked = SEATS.filter((s) => s.state !== 'free').length;
  protected readonly apiCall = API_CALL;
}
