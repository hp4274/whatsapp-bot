/**
 * Typed client for /api/storage: every contact sheet and media attachment the
 * workspace has uploaded. Wire contract with the server's storage routes -
 * change both together.
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import type { ImportPreview, UploadedMedia } from '../core/api';

export type StoredKind = 'sheet' | 'media';

export interface StoredFile {
  readonly id: number;
  readonly kind: StoredKind;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly sha256: string;
  /** Contact rows in a sheet; null for media. */
  readonly rows: number | null;
  readonly mediaId: string | null;
  readonly uses: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface StorageList {
  readonly files: readonly StoredFile[];
  readonly totals: { readonly count: number; readonly bytes: number };
}

/** A sheet comes back as a fresh import preview, media as an upload result. */
export interface StorageUse {
  readonly file: StoredFile;
  readonly preview?: ImportPreview;
  readonly media?: UploadedMedia;
}

@Injectable({ providedIn: 'root' })
export class StorageApi {
  private readonly http = inject(HttpClient);

  /** Newest used first. */
  list(kind?: StoredKind): Observable<StorageList> {
    const params = kind ? new HttpParams().set('kind', kind) : undefined;
    return this.http.get<StorageList>('/api/storage', { params }).pipe(catchError(toMessage));
  }

  /** The bytes need the bearer token, so an `<a href>` cannot fetch them directly. */
  download(id: number): Observable<Blob> {
    return this.http
      .get(`/api/storage/${id}/download`, { responseType: 'blob' })
      .pipe(catchError(toMessage));
  }

  /** Re-open a stored file as if it had just been uploaded (counts as a use). */
  use(id: number): Observable<StorageUse> {
    return this.http.post<StorageUse>(`/api/storage/${id}/use`, {}).pipe(catchError(toMessage));
  }

  /** Rejected with 409 and a reason while a campaign or template still needs the file. */
  remove(id: number): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/storage/${id}`).pipe(catchError(toMessage));
  }
}

/** Surface the server's own words (same rule as core/api.ts). */
function toMessage(error: HttpErrorResponse) {
  // A blob request reads an error body as a Blob, which cannot be parsed synchronously.
  if (error.error instanceof Blob) {
    const gone = error.status === 410;
    return throwError(
      () => new Error(gone ? 'This file is no longer stored.' : 'Could not download this file.'),
    );
  }
  const errors = (error.error as { errors?: string[] } | null)?.errors;
  const message = Array.isArray(errors) && errors.length ? errors.join('\n') : error.message;
  return throwError(() => new Error(message || 'Request failed'));
}
