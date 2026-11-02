import { crossServiceLinking, withinServiceGrouping, type LinkRow } from './linkage';

// M6-03 seam: what an attacker holding copies of the databases can join by equal identifier values, scored against a
// ground truth that only the evaluator has. Nothing here reads a value from a running system.
const row = (service: string, subject: string | null, refs: Record<string, string>): LinkRow => ({
  service,
  subject,
  refs,
});

describe('M6-03 crossServiceLinking', () => {
  it('M6-03 control: equal identifiers across services link every subject (the baseline shape)', () => {
    const rows = [
      row('transaction', 's1', { customer_id: 'C1' }),
      row('fraud', 's1', { customer_id: 'C1' }),
      row('transaction', 's2', { customer_id: 'C2' }),
      row('fraud', 's2', { customer_id: 'C2' }),
    ];
    const result = crossServiceLinking(rows, ['transaction', 'fraud']);
    expect(result.pairs).toEqual([
      expect.objectContaining({
        a: 'transaction',
        b: 'fraud',
        subjectsInBoth: 2,
        linked: 2,
        rate: 1,
      }),
    ]);
  });

  it('M6-03 different tokens per service give no edge at all (the proposed shape)', () => {
    const rows = [
      row('transaction', 's1', { customer_pseudonym: 'PSEU-AAAAAAAA' }),
      row('fraud', 's1', { pseudonym: 'PSEU-BBBBBBBB' }),
    ];
    const result = crossServiceLinking(rows, ['transaction', 'fraud']);
    expect(result.pairs[0]).toMatchObject({ edges: 0, linked: 0, rate: 0, subjectsInBoth: 1 });
  });

  it('M6-03 a value shared by two different subjects is a false edge and links neither', () => {
    const rows = [
      row('transaction', 's1', { customer_id: 'X' }),
      row('fraud', 's2', { customer_id: 'X' }),
    ];
    const pair = crossServiceLinking(rows, ['transaction', 'fraud']).pairs[0];
    expect(pair).toMatchObject({ edges: 1, falseEdges: 1, linked: 0, subjectsInBoth: 0 });
  });

  it('M6-03 only subjects that have rows in both services count in the rate', () => {
    const rows = [
      row('transaction', 's1', { customer_id: 'C1' }),
      row('transaction', 's2', { customer_id: 'C2' }),
      row('fraud', 's1', { customer_id: 'C1' }),
    ];
    expect(crossServiceLinking(rows, ['transaction', 'fraud']).pairs[0]).toMatchObject({
      subjectsInBoth: 1,
      linked: 1,
      rate: 1,
    });
  });

  it('M6-03 colluding services: a subject is chained when its rows in every service join transitively', () => {
    const rows = [
      row('transaction', 's1', { customer_id: 'C1', account_number: 'A1' }),
      row('fraud', 's1', { customer_id: 'C1' }),
      row('reconciliation', 's1', { account_number: 'A1' }),
      row('transaction', 's2', { customer_id: 'C2', account_number: 'A2' }),
      row('fraud', 's2', { customer_id: 'C2' }),
      row('reconciliation', 's2', { account_number: 'OTHER' }),
    ];
    const result = crossServiceLinking(rows, ['transaction', 'fraud', 'reconciliation']);
    expect(result.chain).toMatchObject({ subjectsInAll: 2, chained: 1, rate: 0.5 });
  });

  it('M6-03 a subject missing from one service does not count for the chain', () => {
    const rows = [
      row('transaction', 's1', { customer_id: 'C1' }),
      row('fraud', 's1', { customer_id: 'C1' }),
    ];
    expect(
      crossServiceLinking(rows, ['transaction', 'fraud', 'reconciliation']).chain,
    ).toMatchObject({
      subjectsInAll: 0,
      chained: 0,
      rate: null,
    });
  });
});

describe('M6-03 withinServiceGrouping', () => {
  it('M6-03 the same pseudonym on two rows of one subject groups them (reported, not hidden: S-71)', () => {
    const rows = [
      row('fraud', 's1', { pseudonym: 'P1' }),
      row('fraud', 's1', { pseudonym: 'P1' }),
      row('fraud', 's2', { pseudonym: 'P2' }),
      row('fraud', 's2', { pseudonym: 'P2' }),
    ];
    expect(withinServiceGrouping(rows, 'fraud')).toMatchObject({
      truePairs: 2,
      groupedTruePairs: 2,
      recall: 1,
      precision: 1,
    });
  });

  it('M6-03 a token that changes between rows separates the same subject', () => {
    const rows = [row('fraud', 's1', { pseudonym: 'P1' }), row('fraud', 's1', { pseudonym: 'P9' })];
    expect(withinServiceGrouping(rows, 'fraud')).toMatchObject({
      truePairs: 1,
      groupedTruePairs: 0,
      recall: 0,
    });
  });

  it('M6-03 a value shared by two subjects lowers precision', () => {
    const rows = [row('fraud', 's1', { pseudonym: 'P' }), row('fraud', 's2', { pseudonym: 'P' })];
    expect(withinServiceGrouping(rows, 'fraud')).toMatchObject({
      groupedPairs: 1,
      groupedTruePairs: 0,
      precision: 0,
    });
  });

  it('M6-03 no pair to find is reported as null, not as a success', () => {
    expect(withinServiceGrouping([row('fraud', 's1', { pseudonym: 'P1' })], 'fraud')).toMatchObject(
      {
        truePairs: 0,
        recall: null,
      },
    );
  });
});
