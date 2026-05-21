import { describe, expect, test } from 'bun:test';
import { aggregateVerdicts, placeholderJudge, type JudgeConfig, type JudgeVerdict } from '../../ai';

const verdict = (winner: JudgeVerdict['winner'], a: number, b: number): JudgeVerdict => ({
  winner,
  confidence: 0.8,
  scores: { A: Math.round(a / 10), B: Math.round(b / 10) },
  scores1000: { A: a, B: b },
  margin: Math.abs(a - b),
  criteria: { logic: { A: 8, B: 7 } },
  ruleViolations: [],
  reasoning: 'test',
  decisiveMoments: [{ round: 1, side: winner === 'B' ? 'B' : 'A', summary: 'turning point' }],
});

describe('aggregateVerdicts', () => {
  test('uses majority vote and averaged 1000-point scores', () => {
    const result = aggregateVerdicts([
      verdict('A', 900, 700),
      verdict('A', 840, 780),
      verdict('B', 720, 810),
    ]);

    expect(result.winner).toBe('A');
    expect(result.votes.A).toBe(2);
    expect(result.scores1000).toEqual({ A: 820, B: 763 });
    expect(result.margin).toBe(57);
    expect(result.summary).toContain('Side A wins 820-763');
  });

  test('keeps draw outcome explicit when draw has most votes', () => {
    const result = aggregateVerdicts([
      verdict('draw', 801, 799),
      verdict('draw', 750, 751),
      verdict('A', 830, 700),
    ]);

    expect(result.winner).toBe('draw');
    expect(result.votes.draw).toBe(2);
    expect(result.summary).toContain('too close');
  });

  test('applies judge weights and threshold before awarding a winner', () => {
    const judges = [
      { weight: 3 },
      { weight: 1 },
      { weight: 1 },
    ];
    const result = aggregateVerdicts([
      verdict('A', 760, 620),
      verdict('B', 650, 780),
      verdict('B', 640, 790),
    ], { judges, threshold: 700 });

    expect(result.method).toBe('weighted_majority');
    expect(result.votes.A).toBe(3);
    expect(result.votes.B).toBe(2);
    expect(result.winner).toBe('A');
    expect(result.thresholdMet).toBe(true);
    expect(result.totalWeight).toBe(5);
  });

  test('returns no winner when the leading side misses the configured threshold', () => {
    const result = aggregateVerdicts([
      verdict('A', 640, 610),
      verdict('A', 650, 612),
      verdict('B', 600, 640),
    ], { threshold: 700 });

    expect(result.leader).toBe('A');
    expect(result.winner).toBe('draw');
    expect(result.thresholdMet).toBe(false);
    expect(result.summary).toContain('did not reach the 700-point threshold');
  });

  test('fallback judge keeps 1000-point scores readable for long transcripts', async () => {
    const judge: JudgeConfig = {
      id: 'logic',
      label: 'Logic Judge',
      provider: 'placeholder',
      model: 'placeholder-v1',
      weight: 1,
      persona: 'test',
    };
    const result = await placeholderJudge({
      challengeId: 'long-transcript',
      statement: 'SQLite is a better default database than Postgres for early-stage products.',
      sideALabel: 'SQLite',
      sideBLabel: 'Postgres',
      rules: {},
      context: {},
      transcript: [
        { roundNumber: 1, side: 'A', body: 'SQLite is simple and practical. '.repeat(90) },
        { roundNumber: 1, side: 'B', body: 'Postgres has evidence because cost risk example proof counter instead. '.repeat(90) },
      ],
    }, judge);

    expect(result.winner).toBe('B');
    expect(result.scores1000.B).toBeGreaterThan(result.scores1000.A);
    expect(result.scores1000).not.toEqual({ A: 1000, B: 1000 });
  });
});
