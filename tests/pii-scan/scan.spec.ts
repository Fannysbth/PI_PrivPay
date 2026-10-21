import { CANARY_ATTRIBUTES, buildCanary } from './canary';
import { assertNoFindings, scanText } from './scan';

// Seam: scanText and assertNoFindings. The scanner must never be a place where a value leaks (ticket note).
const person = buildCanary(11);
const bystander = buildCanary(12);
const context = { service: 'transaction', location: 'request-body' } as const;

describe('M2-10 scanText', () => {
  it.each(CANARY_ATTRIBUTES)('M2-10 positive: a planted %s is found', (attribute) => {
    const text = `{"note":"x","field":"${person[attribute]}","tail":1}`;
    expect(scanText(text, [person], context)).toEqual([
      { attribute, location: 'request-body', service: 'transaction' },
    ]);
  });

  it('M2-10 negative: clean text and the canary of nobody in the list give no finding', () => {
    expect(
      scanText('{"pseudonym":"PSEU-0A1B2C3D","transaction_id":"TX-1"}', [person], context),
    ).toEqual([]);
    expect(scanText(`{"x":"${bystander.nik}"}`, [person], context)).toEqual([]);
  });

  it('M2-10 one finding per attribute and location even when the value repeats', () => {
    const text = `${person.hp} ${person.hp} ${person.nik}`;
    expect(
      scanText(text, [person], context)
        .map((finding) => finding.attribute)
        .sort(),
    ).toEqual(['hp', 'nik']);
  });

  it('M2-10 finds the value of any listed customer and a percent-encoded one', () => {
    const encoded = encodeURIComponent(person.email);
    expect(scanText(`/x?e=${encoded}`, [bystander, person], context)).toEqual([
      { attribute: 'email', location: 'request-body', service: 'transaction' },
    ]);
  });

  it('M2-10 finds a form-encoded name, where a space is a plus sign', () => {
    const encoded = `nama=${person.nama.replaceAll(' ', '+')}`;
    expect(scanText(encoded, [person], context).map((finding) => finding.attribute)).toEqual([
      'nama',
    ]);
  });

  it('M2-10 the output holds the three keys and no value', () => {
    const findings = scanText(Object.values(person).join(' '), [person], context);
    expect(findings).toHaveLength(CANARY_ATTRIBUTES.length);
    for (const finding of findings)
      expect(Object.keys(finding).sort()).toEqual(['attribute', 'location', 'service']);
    const printed = JSON.stringify(findings);
    for (const value of Object.values(person)) expect(printed).not.toContain(value);
  });
});

describe('M2-10 assertNoFindings', () => {
  it('M2-10 passes on no finding', () => {
    expect(() => {
      assertNoFindings([]);
    }).not.toThrow();
  });

  it('M2-10 NFR-15 fails when a canary was planted, and the message names no value', () => {
    const findings = scanText(`log line ${person.nama} ${person.customer_id}`, [person], {
      service: 'privacy',
      location: 'log',
    });
    let message = '';
    try {
      assertNoFindings(findings);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('nama');
    expect(message).toContain('privacy');
    for (const value of Object.values(person)) expect(message).not.toContain(value);
  });
});
