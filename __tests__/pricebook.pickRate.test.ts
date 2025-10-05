import { pickRate, PriceRow } from '../src/lib/pricebook';

describe('pickRate', () => {
  const row: PriceRow = {
    cf_item_name: 'AAA',
    item_name: 'AAA-ITEM',
    cf_size_1: '90x100',
    cf_packing: '2pc',
    default_qty: 1,
    exmill: 123,
    nett: 150,
  };

  test('Exmill picks exmill rate', () => {
    expect(pickRate(row, 'Exmill')).toBe(123);
  });

  test('Nett picks nett rate', () => {
    expect(pickRate(row, 'Nett')).toBe(150);
  });

  test('Manual uses provided manualRate', () => {
    expect(pickRate(row, 'Manual', 777)).toBe(777);
  });

  test('Empty price list defaults to 0', () => {
    expect(pickRate(row, '')).toBe(0);
    expect(pickRate(row, undefined)).toBe(0);
  });
});
