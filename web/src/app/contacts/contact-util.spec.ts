import { spacedPhone } from './contact-util';

describe('spacedPhone', () => {
  it('splits the country code from the national number', () => {
    expect(spacedPhone('919773444404')).toBe('+91 9773444404');
    expect(spacedPhone('14155550123')).toBe('+1 4155550123');
    expect(spacedPhone('971501234567')).toBe('+971 501234567');
    expect(spacedPhone('447700900123')).toBe('+44 7700900123');
  });

  it('leaves what is not a plain number alone', () => {
    expect(spacedPhone('12345')).toBe('+12345');
    expect(spacedPhone('abc@lid')).toBe('abc@lid');
  });
});
