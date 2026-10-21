import {
  RiskEngine,
  type PriorAssessment,
  type RiskConfig,
  type RiskInput,
  type RuleRow,
} from '../src/risk';

// Seam: RiskEngine.evaluate (spec fraud 2, 4), pure: no database, no clock. The cases are the worked example of PRD 10
// and 16, the boundaries of every rule, and the mapping of the score to a decision. Every value is invented.
const CONFIG: RiskConfig = {
  amountThreshold: 1_000_000,
  oddHourStart: 22,
  oddHourEnd: 6,
  holdThreshold: 50,
  blockThreshold: 90,
};
const RULES: readonly RuleRow[] = [
  {
    rule: 'AMOUNT_OVER_THRESHOLD',
    parameter: 'env:FRAUD_AMOUNT_THRESHOLD',
    weight: 10,
    active: true,
  },
  { rule: 'ODD_HOUR_OUTSIDE_06_22', parameter: 'env:FRAUD_ODD_HOUR', weight: 20, active: true },
  { rule: 'AMOUNT_OVER_3X_AVG', parameter: '3.00', weight: 25, active: true },
  { rule: 'NEW_LOCATION_VS_LAST_3', parameter: '3', weight: 20, active: true },
];
const engine = new RiskEngine();
const input = (over: Partial<RiskInput> = {}): RiskInput => ({
  amount: 1_500_000,
  txHour: 12,
  geohash: 'qqgu4',
  ...over,
});
const evaluate = (
  over: Partial<RiskInput> = {},
  history: readonly PriorAssessment[] = [],
  rules: readonly RuleRow[] = RULES,
  config: RiskConfig = CONFIG,
) => engine.evaluate(input(over), history, rules, config);
const sorted = (list: readonly string[]): string[] => [...list].sort();

describe('M4-04 FR-37 TF-12 C-07 the worked example of the PRD', () => {
  it('M4-04 FR-37 a cold start scores only the amount and the hour, and two rules are skipped', () => {
    const result = evaluate({ amount: 2_000_000, txHour: 13, geohash: 'qqgu7' });
    expect(result).toMatchObject({
      score: 10,
      decision: 'ALLOW',
      priorCount: 0,
      avgPriorAmount: null,
    });
    expect(result.fired).toEqual(['AMOUNT_OVER_THRESHOLD']);
    expect(sorted(result.skipped)).toEqual(['AMOUNT_OVER_3X_AVG', 'NEW_LOCATION_VS_LAST_3']);
  });

  it('M4-04 TF-12 FR-37 the second assessment uses the first: 10 + 25 + 20 + 20 = 75, HOLD_FOR_VERIFICATION, prior_count 1', () => {
    const result = evaluate({ amount: 8_000_000, txHour: 2, geohash: 'qqt8h' }, [
      { amount: 2_000_000, geohash: 'qqgu7' },
    ]);
    expect(result).toMatchObject({
      score: 75,
      decision: 'HOLD_FOR_VERIFICATION',
      priorCount: 1,
      avgPriorAmount: 2_000_000,
      skipped: [],
    });
    expect(sorted(result.fired)).toEqual([
      'AMOUNT_OVER_3X_AVG',
      'AMOUNT_OVER_THRESHOLD',
      'NEW_LOCATION_VS_LAST_3',
      'ODD_HOUR_OUTSIDE_06_22',
    ]);
  });

  it('M4-04 TF-12 an amount under three times the average from the same place scores only 10', () => {
    const result = evaluate({ amount: 1_500_000, txHour: 16, geohash: 'qqgu4' }, [
      { amount: 1_200_000, geohash: 'qqgu4' },
    ]);
    expect(result).toMatchObject({ score: 10, decision: 'ALLOW', priorCount: 1 });
    expect(result.fired).toEqual(['AMOUNT_OVER_THRESHOLD']);
  });

  it('M4-04 C-07 the highest score the rules allow is 75, so the block threshold of 90 cannot be reached by them', () => {
    const result = evaluate({ amount: 9_000_000, txHour: 3, geohash: 'zzzzz' }, [
      { amount: 1_000_000, geohash: 'qqgu4' },
    ]);
    expect(result.score).toBe(75);
    expect(result.decision).not.toBe('BLOCK');
  });
});

describe('M4-04 C-07 the amount threshold', () => {
  it.each([
    [999_999, false],
    [1_000_000, true],
    [1_000_001, true],
  ])('M4-04 C-07 an amount of %s fires AMOUNT_OVER_THRESHOLD: %s', (amount, fires) => {
    expect(evaluate({ amount }).fired.includes('AMOUNT_OVER_THRESHOLD')).toBe(fires);
  });

  it('M4-04 K-20 the threshold comes from the configuration, not from a literal', () => {
    const result = evaluate({ amount: 500 }, [], RULES, { ...CONFIG, amountThreshold: 500 });
    expect(result.fired).toContain('AMOUNT_OVER_THRESHOLD');
  });
});

describe('M4-04 C-07 the hours outside 06:00 to 22:00', () => {
  it.each([
    [0, true],
    [5, true],
    [6, false],
    [12, false],
    [21, false],
    [22, true],
    [23, true],
  ])('M4-04 C-07 hour %s fires ODD_HOUR_OUTSIDE_06_22: %s', (txHour, fires) => {
    expect(evaluate({ amount: 10, txHour }).fired.includes('ODD_HOUR_OUTSIDE_06_22')).toBe(fires);
  });

  it('M4-04 K-20 the hours come from the configuration', () => {
    const night = { ...CONFIG, oddHourStart: 20, oddHourEnd: 8 };
    expect(evaluate({ amount: 10, txHour: 7 }, [], RULES, night).fired).toContain(
      'ODD_HOUR_OUTSIDE_06_22',
    );
    expect(evaluate({ amount: 10, txHour: 8 }, [], RULES, night).fired).not.toContain(
      'ODD_HOUR_OUTSIDE_06_22',
    );
  });
});

describe('M4-04 FR-37 the rules that need a history', () => {
  it('M4-04 FR-37 the amount is over three times the average of the whole history, strictly', () => {
    const history = [
      { amount: 1_000_000, geohash: 'qqgu4' },
      { amount: 2_000_000, geohash: 'qqgu4' },
    ];
    // The average is 1,500,000: 4,500,000 is exactly three times and does not fire, one more does.
    expect(evaluate({ amount: 4_500_000 }, history).fired).not.toContain('AMOUNT_OVER_3X_AVG');
    expect(evaluate({ amount: 4_500_001 }, history).fired).toContain('AMOUNT_OVER_3X_AVG');
    expect(evaluate({ amount: 4_500_001 }, history).avgPriorAmount).toBe(1_500_000);
  });

  it('M4-04 FR-37 the multiplier comes from the rule table', () => {
    const rules = RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_3X_AVG' ? { ...row, parameter: '2.00' } : row,
    );
    const history = [{ amount: 1_000_000, geohash: 'qqgu4' }];
    expect(evaluate({ amount: 2_000_001 }, history, rules).fired).toContain('AMOUNT_OVER_3X_AVG');
    expect(evaluate({ amount: 2_000_000 }, history, rules).fired).not.toContain(
      'AMOUNT_OVER_3X_AVG',
    );
  });

  it('M4-04 FR-37 a place among the three latest is known, the fourth latest is not', () => {
    const history = [
      { amount: 1, geohash: 'aaaaa' },
      { amount: 1, geohash: 'bbbbb' },
      { amount: 1, geohash: 'ccccc' },
      { amount: 1, geohash: 'ddddd' },
    ];
    for (const known of ['aaaaa', 'bbbbb', 'ccccc']) {
      expect(evaluate({ geohash: known }, history).fired).not.toContain('NEW_LOCATION_VS_LAST_3');
    }
    expect(evaluate({ geohash: 'ddddd' }, history).fired).toContain('NEW_LOCATION_VS_LAST_3');
    expect(evaluate({ geohash: 'eeeee' }, history).fired).toContain('NEW_LOCATION_VS_LAST_3');
  });

  it('M4-04 FR-37 a past assessment without a place does not make a place known', () => {
    const result = evaluate({ geohash: 'qqgu4' }, [{ amount: 1, geohash: null }]);
    expect(result.fired).toContain('NEW_LOCATION_VS_LAST_3');
  });
});

describe('M4-04 FR-37 the score and the decision', () => {
  const only = (weight: number): readonly RuleRow[] =>
    RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_THRESHOLD' ? { ...row, weight } : { ...row, active: false },
    );
  it.each([
    [49, 'ALLOW'],
    [50, 'HOLD_FOR_VERIFICATION'],
    [89, 'HOLD_FOR_VERIFICATION'],
    [90, 'BLOCK'],
    [120, 'BLOCK'],
  ])(
    'M4-04 FR-37 C-07 a score of %s is %s (the mapping of BLOCK, by injected score)',
    (weight, decision) => {
      const result = evaluate({ amount: 2_000_000 }, [], only(weight));
      expect(result.score).toBe(weight);
      expect(result.decision).toBe(decision);
    },
  );

  it('M4-04 K-20 the decision thresholds come from the configuration', () => {
    const strict = { ...CONFIG, holdThreshold: 10, blockThreshold: 20 };
    expect(evaluate({ amount: 2_000_000 }, [], RULES, strict).decision).toBe(
      'HOLD_FOR_VERIFICATION',
    );
    expect(evaluate({ amount: 2_000_000, txHour: 3 }, [], RULES, strict).decision).toBe('BLOCK');
  });

  it('M4-04 K-20 the weights come from the rule table, not from literals', () => {
    const heavy = RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_THRESHOLD' ? { ...row, weight: 33 } : row,
    );
    expect(evaluate({ amount: 2_000_000 }, [], heavy).score).toBe(33);
  });

  it('M4-04 K-20 a rule that is not active, or missing, is skipped and adds nothing', () => {
    const off = RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_THRESHOLD' ? { ...row, active: false } : row,
    );
    const result = evaluate({ amount: 2_000_000 }, [], off);
    expect(result.score).toBe(0);
    expect(result.skipped).toContain('AMOUNT_OVER_THRESHOLD');
    const missing = RULES.filter((row) => row.rule !== 'ODD_HOUR_OUTSIDE_06_22');
    const gone = evaluate({ amount: 10, txHour: 3 }, [], missing);
    expect(gone.score).toBe(0);
    expect(gone.skipped).toContain('ODD_HOUR_OUTSIDE_06_22');
  });

  it('M4-04 K-20 a broken multiplier stops the assessment at a cold start too, not only once a history exists', () => {
    const broken = RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_3X_AVG' ? { ...row, parameter: '0' } : row,
    );
    expect(() => evaluate({}, [], broken)).toThrow(RangeError);
    // A rule that is switched off is not read, so its parameter cannot stop anything.
    const off = broken.map((row) =>
      row.rule === 'AMOUNT_OVER_3X_AVG' ? { ...row, active: false } : row,
    );
    expect(() => evaluate({}, [], off)).not.toThrow();
  });

  it('M4-04 K-20 a multiplier that is not a positive number stops the assessment instead of guessing', () => {
    const broken = RULES.map((row) =>
      row.rule === 'AMOUNT_OVER_3X_AVG' ? { ...row, parameter: 'three' } : row,
    );
    expect(() => evaluate({}, [{ amount: 1, geohash: 'qqgu4' }], broken)).toThrow(RangeError);
  });
});
