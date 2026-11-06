import { TestBed } from '@angular/core/testing';
import { Subject, take } from 'rxjs';

import { ContactsApi, type ImportPreview } from '../core/api';
import { ImportWizard, plainReason } from './import-wizard';

function preview(filename: string): ImportPreview {
  return {
    filename,
    headers: ['phone'],
    rows: [['9876543210']],
    rowCount: 1,
    mapping: ['phone'],
    fieldKeys: [],
  } as unknown as ImportPreview;
}

describe('ImportWizard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('uses only the last file picked, so the import sends the file that was mapped', () => {
    const previews: Subject<ImportPreview>[] = [];
    const importMapped = vi.fn(() => new Subject());
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ContactsApi,
          useValue: {
            importPreview: () => {
              const call = new Subject<ImportPreview>();
              previews.push(call);
              return call.pipe(take(1));
            },
            importMapped,
          },
        },
      ],
    });
    const wizard = TestBed.runInInjectionContext(() => new ImportWizard()) as unknown as {
      upload: (file: File) => void;
      commit: () => void;
      file: () => File | null;
      preview: () => ImportPreview | null;
    };
    const a = new File(['a'], 'a.csv');
    const b = new File(['b'], 'b.csv');
    wizard.upload(a);
    wizard.upload(b);
    previews[1].next(preview('b.csv'));
    previews[0].next(preview('a.csv')); // the slower first answer lands last
    expect(wizard.preview()?.filename).toBe('b.csv');
    expect(wizard.file()).toBe(b);

    wizard.commit();
    expect(importMapped).toHaveBeenCalledWith(b, ['phone'], []);
  });
});

describe('plainReason', () => {
  it('words the server phone errors for a business owner', () => {
    expect(plainReason('Row 4: not a valid E.164 number: notaphone1 -> 1')).toBe(
      'Row 4: "notaphone1" is not a valid phone number',
    );
    expect(plainReason('Row 5: missing phone number')).toBe('Row 5: no phone number');
    expect(plainReason('Row 6: something else')).toBe('Row 6: something else');
  });
});
