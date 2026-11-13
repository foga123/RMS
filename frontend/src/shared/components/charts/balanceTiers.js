/**
 * Turn balance tiers into the bars of the finance card: how many students sit
 * in each band of what they owe.
 *
 * WHAT THIS CARD PLOTS, AND WHAT IT USED TO
 *
 * Three shapes preceded the current one. A waterfall, which read well alone
 * and badly beside the other cards — it was the only one whose bars did not
 * share a baseline. Then bars of PESOS per band, which answered "where is the
 * money" (the KPI tile already answers that in one number) and made the band
 * holding the most students look like the smallest problem, because a handful
 * of large debts outweigh a great many small ones. Then one stacked bar cut
 * into the bands, on the reasoning that "how much of the college is in
 * financial trouble" is a composition rather than a comparison.
 *
 * That reasoning was sound about finance and wrong about the panel. This card
 * sits in a grid with three Recharts figures, and being the only hand-drawn
 * one made it read as a different KIND of thing — its own typography, its own
 * legend, a title attribute instead of the shared tooltip, and no table axis
 * to check a number against. A reader comparing the finance card with the
 * students card was crossing a stylistic gap that carried no meaning.
 *
 * So it is a horizontal bar of headcounts now, the same shape as "Students by
 * year level" directly above it. The composition reading is not lost: `share`
 * still rides on every tier and the tooltip states it, so the one thing the
 * stacked bar said better is still said.
 *
 * `color` runs green through deepening amber, and the order the API returns
 * them in — No Balance first, then ascending debt — is the order they are
 * drawn, so the axis reads top to bottom as "fine" to "worst".
 *
 * Kept out of the chart component so the arithmetic can be read and tested on
 * its own.
 */

/**
 * Ordinal ramp for the tiers that owe something, lightest to darkest as the
 * balance grows. See OverviewCharts.
 *
 * Four steps since the bands became the sheet's own (1 to 3K / 3K to 5K /
 * 5K to 7.5K / 7.5K and Up). With three, the ramp's Math.min() clamp painted
 * the top two bands the same darkest amber, so the chart showed four bars in
 * three colours and the two biggest looked like one band split in half.
 */
export const BALANCE_STEPS = ["#fbbf24", "#f59e0b", "#d97706", "#b45309"];

/**
 * The tier that owes nothing is not a lighter shade of owing — it is the good
 * outcome, so it leaves the amber ramp entirely and takes the same green the
 * grades chart uses for "passed".
 */
export const BALANCE_CLEAR_COLOR = "#059669";

export function buildBalanceTiers(tiers) {
  /*
   * Filtered on students, not on amount.
   *
   * A segment is a headcount, so the only tier that cannot be drawn is one
   * nobody is in. Filtering on amount — which is what this did while the bars
   * measured pesos — silently dropped "No Balance" and its 77 students from a
   * chart about where students sit, which is the one band a finance office most
   * wants a number for.
   */
  const list = (Array.isArray(tiers) ? tiers : []).filter((tier) => Number(tier?.students) > 0);
  const totalStudents = list.reduce((sum, tier) => sum + (Number(tier.students) || 0), 0);

  // Stepped across the owing tiers only, so "No Balance" sitting at the front
  // does not push the first owing tier a shade darker than it should be.
  let owingIndex = 0;

  return list.map((tier) => {
    const amount = Number(tier.amount) || 0;
    const students = Number(tier.students) || 0;

    /*
     * A tier whose newest bills sum to nothing is the no-balance tier, whatever
     * it happens to be called. Read from the data rather than matched on the
     * name or the seeded status id, so renaming the status or reseeding it
     * cannot quietly turn the clear band amber.
     */
    const owes = amount > 0;
    const color = owes
      ? BALANCE_STEPS[Math.min(owingIndex, BALANCE_STEPS.length - 1)]
      : BALANCE_CLEAR_COLOR;
    if (owes) owingIndex += 1;

    return {
      label: String(tier.label ?? ""),
      students,
      amount,
      owes,
      share: totalStudents > 0 ? (students / totalStudents) * 100 : 0,
      color,
    };
  });
}

/**
 * Students with nothing owing.
 *
 * Still exported because the KPI tile above the charts uses it as its meta line
 * — "77 owe nothing" beside the total owed. The chart no longer needs it: that
 * band is a bar of its own now.
 */
export function studentsWithNoBalance(tiers) {
  const clear = (Array.isArray(tiers) ? tiers : []).find((tier) => Number(tier?.amount) === 0);
  return clear ? clear.students : null;
}
