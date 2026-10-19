describe('fixture', () => {
  it.only('is focused', () => {
    expect(1).toBe(1);
  });

  it.skip('is skipped', () => {
    expect(1).toBe(1);
  });

  xit('is skipped through an alias', () => {
    expect(1).toBe(1);
  });
});
