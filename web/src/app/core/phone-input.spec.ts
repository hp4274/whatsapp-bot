import { joinPhone, splitPhone } from './phone-input';

describe('splitPhone', () => {
  it('reads the country code after a "+", longest code first', () => {
    expect(splitPhone('+91 98765 43210')).toEqual({ code: '91', number: '98765 43210' });
    expect(splitPhone('+971 50 123 4567')).toEqual({ code: '971', number: '50 123 4567' });
    expect(splitPhone('+919876543210')).toEqual({ code: '91', number: '9876543210' });
  });

  it('splits a stored number written without a "+", and leaves a plain one in the default country', () => {
    expect(splitPhone('919876543210')).toEqual({ code: '91', number: '9876543210' });
    expect(splitPhone('98765 43210')).toEqual({ code: '91', number: '98765 43210' });
    expect(splitPhone('')).toEqual({ code: '91', number: '' });
  });

  it('joins back to what the forms send, and to nothing without a number', () => {
    expect(joinPhone('971', '50 123 4567')).toBe('+971 50 123 4567');
    expect(joinPhone('91', '  ')).toBe('');
    const { code, number } = splitPhone('+44 7700 900123');
    expect(joinPhone(code, number)).toBe('+44 7700 900123');
  });
});
