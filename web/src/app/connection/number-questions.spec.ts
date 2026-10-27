import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { ChannelsApi, type NumberStart } from '../core/api';
import { NumberQuestions } from './number-questions';

const INFO: NumberStart = {
  asked: false,
  todayLimit: 20,
  planLimit: 250,
  skipWarning: { version: '2026-10-1', text: ['First risk.', 'Second risk.', 'Third risk.'] },
  suggested: null,
};

/** The component over a stub API; the test reads the rendered DOM. */
function setup(info: NumberStart = INFO, popup = false) {
  const api = {
    startInfo: vi.fn(() => of(info)),
    start: vi.fn(() => of({ todayLimit: 60, planLimit: 250 })),
  };
  // jsdom has no modal dialogs; opening one only needs to flip `open`.
  const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  TestBed.configureTestingModule({ providers: [{ provide: ChannelsApi, useValue: api }] });
  const fixture = TestBed.createComponent(NumberQuestions);
  fixture.componentRef.setInput('channelId', 4);
  if (popup) fixture.componentRef.setInput('popup', true);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = (target: Element | null) => {
    (target as HTMLElement).click();
    fixture.detectChanges();
  };
  return { fixture, el, api, click };
}

describe('NumberQuestions', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('pre-selects the answers the chat history suggests, and says where they came from', () => {
    const { el, api, click } = setup({ ...INFO, suggested: { age: 3, usage: 2, chats: 240 } });
    const checked = (name: string) =>
      [...el.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].findIndex((i) => i.checked);
    expect([checked('nq-age'), checked('nq-usage')]).toEqual([3, 2]);
    expect(el.textContent).toContain('Picked from the 240 chats already on this number.');

    click(el.querySelector('button[type="submit"]'));
    expect(api.start).toHaveBeenCalledWith(4, { age: 3, usage: 2 });
  });

  it('keeps Start disabled until both questions are answered, then posts the answers', () => {
    const { el, api, click } = setup();
    const submit = () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit().disabled).toBe(true);

    click(el.querySelectorAll('input[name="nq-age"]')[1]);
    expect(submit().disabled).toBe(true);
    click(el.querySelectorAll('input[name="nq-usage"]')[2]);
    expect(submit().disabled).toBe(false);

    click(submit());
    expect(api.start).toHaveBeenCalledWith(4, { age: 1, usage: 2 });
    expect(el.querySelector('[role="status"]')?.textContent).toContain(
      'This number runs at 60 messages a day.',
    );
    expect(el.textContent).toContain('up to 250 a day as people reply');
  });

  it('only skips once the risk is accepted', () => {
    const { el, api, click } = setup();
    click(el.querySelector('.skip'));
    const dialog = el.querySelector('dialog')!;
    expect(dialog.textContent).toContain('Second risk.');
    const confirm = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(confirm.disabled).toBe(true);

    click(dialog.querySelector('input[type="checkbox"]'));
    expect(confirm.disabled).toBe(false);
    click(confirm);
    expect(api.start).toHaveBeenCalledWith(4, { skip: true, accept: true });
  });

  it('shows nothing for a number that already answered', () => {
    const { fixture, el } = setup({ ...INFO, asked: true });
    expect(el.querySelector('form')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).style.display).toBe('none');
  });

  it('as a popup, opens by itself for an unanswered number and closes with Done once answered', () => {
    const { el, click } = setup(INFO, true);
    const ask = el.querySelector<HTMLDialogElement>('dialog.ask')!;
    expect(ask.open).toBe(true);
    expect(ask.textContent).toContain('Answer 2 questions to start sending');

    click(ask.querySelectorAll('input[name="nq-age"]')[3]);
    click(ask.querySelectorAll('input[name="nq-usage"]')[3]);
    click(ask.querySelector('button[type="submit"]'));
    expect(ask.querySelector('[role="status"]')?.textContent).toContain('60 messages a day');

    click([...ask.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Done')!);
    expect(ask.open).toBe(false);
  });

  it('as a popup, Later closes it without answering', () => {
    const { el, api, click } = setup(INFO, true);
    const ask = el.querySelector<HTMLDialogElement>('dialog.ask')!;
    click([...ask.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Later')!);
    expect(ask.open).toBe(false);
    expect(api.start).not.toHaveBeenCalled();
  });

  it('as a popup, never opens for a number that already answered', () => {
    const { el } = setup({ ...INFO, asked: true }, true);
    expect(el.querySelector<HTMLDialogElement>('dialog.ask')?.open ?? false).toBe(false);
  });
});
