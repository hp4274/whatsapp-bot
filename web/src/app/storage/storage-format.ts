/** Display helpers shared by the Storage page and the "reuse a previous file" pickers. */

import { formatBytes } from '../campaign/wa-format';
import type { StoredFile } from './storage-api';

export type FileType = 'sheet' | 'image' | 'pdf' | 'video' | 'doc';

/** Tabler glyphs, rendered as `ti ti-<icon>`. */
export const FILE_ICON: Readonly<Record<FileType, string>> = {
  sheet: 'file-spreadsheet',
  image: 'photo',
  pdf: 'file-type-pdf',
  video: 'video',
  doc: 'file-text',
};

const TYPE_LABEL: Readonly<Record<FileType, string>> = {
  sheet: 'Contact list',
  image: 'Image',
  pdf: 'PDF',
  video: 'Video',
  doc: 'Document',
};

export function fileType(f: Pick<StoredFile, 'kind' | 'mimetype'>): FileType {
  if (f.kind === 'sheet') return 'sheet';
  if (f.mimetype.startsWith('image/')) return 'image';
  if (f.mimetype.startsWith('video/')) return 'video';
  if (f.mimetype === 'application/pdf') return 'pdf';
  return 'doc';
}

/** "12 Oct 2026"; empty for a missing or unparseable time. */
export function shortDate(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function rowsLabel(rows: number): string {
  return `${rows.toLocaleString()} ${rows === 1 ? 'contact' : 'contacts'}`;
}

/** What a picker row says about a file: contacts for a sheet, the size for media. */
export function fileDetail(f: StoredFile): string {
  return f.kind === 'sheet' && f.rows !== null ? rowsLabel(f.rows) : formatBytes(f.size);
}

/** Second line of a file card: what it is, then how big. */
export function fileMeta(f: StoredFile): string {
  const what = f.kind === 'sheet' && f.rows !== null ? rowsLabel(f.rows) : TYPE_LABEL[fileType(f)];
  return `${what} · ${formatBytes(f.size)}`;
}
