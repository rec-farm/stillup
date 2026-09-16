import { expect, it } from 'vitest';
import { accessibleAccent } from './appearance';
it('keeps white labels readable even for pale brand colors', () => {
  for (const hex of ['#ffffff', '#ffee00', '#00ff00', '#087f67', '#2563eb', '#000000']) {
    const color = accessibleAccent(hex);
    const luminance = [1, 3, 5].reduce((sum, offset, index) => {
      const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return (
        sum +
        (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]!
      );
    }, 0);
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
  expect(accessibleAccent('#087f67')).toBe('#087f67');
});
