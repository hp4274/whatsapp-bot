/**
 * The numbers a linked WhatsApp account knows, read from WhatsApp itself
 * (`GET /api/admin/tenants/:id/contacts`): the account's address book plus the
 * members of every group and community it has joined. Never the platform's own
 * contact rows.
 */
export interface AccountNumber {
  readonly phone: string;
  /** The address-book name, or a profile name when the number is not saved; '' when WhatsApp gives none. */
  readonly name: string;
  /** The user put this number in the phone's address book. */
  readonly saved: boolean;
  /** Names of the groups and communities this number is a member of. */
  readonly groups: string[];
}

/** One group or community the linked number has joined. */
export interface AccountGroup {
  readonly id: string;
  readonly name: string;
  /** What WhatsApp reports, which can include members it does not name. */
  readonly size: number;
  readonly isCommunity: boolean;
  /** The parent community's id for a subgroup, else null. */
  readonly community: string | null;
  readonly communityName: string;
  /** Members whose number WhatsApp showed. */
  readonly members: number;
  /** Members WhatsApp only shows by LID: their number is not readable. */
  readonly hidden: number;
}

export interface NumberDetails {
  readonly source: 'whatsapp_account';
  /** The linked number itself. */
  readonly account: string;
  /** Every readable number, one row each, sorted by number. */
  readonly contacts: AccountNumber[];
  /** The same numbers as plain digits. */
  readonly numbers: string[];
  readonly groups: AccountGroup[];
  /** Numbers in the address book. */
  readonly saved: number;
  /** Numbers and members WhatsApp would not show. */
  readonly hidden: number;
  readonly total: number;
}
