<?php
/**
 * Configurable retention risk scoring.
 *
 * Replaces the hardcoded ladders in retention_case.php (SURVEY_RISK_KEYWORDS,
 * evaluate_academic_risk, evaluate_survey_risk) with a model loaded from the
 * database, so weights and thresholds are tunable without a code change.
 *
 * Two steps, deliberately separate:
 *
 *   risk_collect_signals()  reads the student's term data and flattens it into
 *                           a map of scalar signals. Knows about tables, knows
 *                           nothing about scoring.
 *   risk_evaluate_signals() applies the model's indicator rules to that map.
 *                           Knows about scoring, knows nothing about tables.
 *
 * That split is what makes new signals cheap: publish a new key in
 * risk_collect_signals() and it is immediately addressable by a rule row.
 *
 * PUBLISHED SIGNAL KEYS  (source => field_key)
 *   grades     => remark_risk, failed, incomplete, no_credit, no_grade,
 *                 total_subject, passed, pass_rate, record
 *   finance    => balance_amount, balance_tier, balance_unchanged, record
 *   attendance => present, absent, total_classes_conducted, absent_rate,
 *                 present_rate, record
 *   survey     => submission, survey.<category_code>
 *
 * The `record` key exists so a rule can use the `missing` / `present`
 * operator to score the *absence* of data, which is itself a signal.
 */

if (!defined('RISK_MODEL_SERVICE_LOADED')) {
    define('RISK_MODEL_SERVICE_LOADED', true);

// api_period_filter_sql()/api_normalize_period(): the shared vocabulary for
// "which periodical", so this scores the same slice the screens are showing.
require_once __DIR__ . '/periodic_lib.php';


/**
 * The enrolment standings that mean "this student is staying", and the ones
 * that mean they are not, from the `status` table's enrollment rows.
 *
 * Ids rather than names because the names are the institution's to edit and a
 * rename must not silently move a student from one side of the line to the
 * other. Anything absent from both lists - Undecided, CBR, WFR, Others - is
 * deliberately neither: those are answers that withhold a decision, and the
 * survey signal stays null for them.
 *
 * define() rather than const because this file is wrapped in a
 * !defined() include guard, and const is not legal inside a block.
 */
define('RISK_SURVEY_STAYING_STATUS_IDS', [
    3,   // Enrolled
    5,   // Will Enroll
    20,  // For Enlistment
    21,  // Graduating
    22,  // To Shift
]);
define('RISK_SURVEY_LEAVING_STATUS_IDS', [
    4,   // Not Enrolled
    23,  // To Transfer
    27,  // No Show
    28,  // To Stop
]);

/**
 * Did the risk model migration run? Everything degrades to the legacy
 * evaluator when it has not, so the endpoint keeps working on an un-migrated
 * database.
 */
function risk_model_tables_exist(PDO $pdo): bool
{
    static $exists = null;
    if ($exists !== null) {
        return $exists;
    }
    try {
        $found = $pdo->query(
            "SHOW TABLES LIKE 'risk_model'"
        )->fetchColumn();
        $exists = (bool)$found;
    } catch (Throwable $e) {
        $exists = false;
    }
    return $exists;
}

/**
 * The model to score with: the active one for this exact term, else the active
 * global one. Returns null when nothing is active, which is the signal to fall
 * back to the legacy evaluator.
 */
function risk_model_get_active(PDO $pdo, ?int $schoolYearId = null, ?int $semesterId = null): ?array
{
    if (!risk_model_tables_exist($pdo)) {
        return null;
    }

    $stmt = $pdo->prepare(
        "SELECT model_id, model_name, moderate_threshold, high_threshold,
                school_year_id, semester_id
           FROM risk_model
          WHERE is_active = 1
            AND (school_year_id IS NULL OR school_year_id = :sy)
            AND (semester_id    IS NULL OR semester_id    = :sem)
       ORDER BY (school_year_id IS NOT NULL) + (semester_id IS NOT NULL) DESC,
                model_id DESC
          LIMIT 1"
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $model = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$model) {
        return null;
    }

    $model['model_id']           = (int)$model['model_id'];
    $model['moderate_threshold'] = (float)$model['moderate_threshold'];
    $model['high_threshold']     = (float)$model['high_threshold'];
    $model['indicators']         = risk_model_load_indicators($pdo, $model['model_id']);

    return $model;
}

function risk_model_load_indicators(PDO $pdo, int $modelId): array
{
    $stmt = $pdo->prepare(
        "SELECT i.indicator_id, i.category_id, c.category_code, c.category_name,
                i.label, i.source, i.field_key, i.operator,
                i.value_min, i.value_max, i.value_text, i.points, i.reason_template
           FROM risk_indicator i
           JOIN risk_category c ON c.category_id = i.category_id
          WHERE i.model_id = :mid AND i.is_active = 1 AND c.is_active = 1
       ORDER BY i.sort_order, i.indicator_id"
    );
    $stmt->execute([':mid' => $modelId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

/**
 * Read every term signal for one student into a flat map keyed "source.field".
 *
 * $gradeRow may be passed in when the caller already fetched it (retention_case
 * does), which keeps the enriched remark_risk_level it computed.
 */
function risk_collect_signals(
    PDO $pdo,
    int $studentId,
    ?int $semesterId,
    ?int $schoolYearId,
    ?array $gradeRow = null,
    ?array $submissionRow = null,
    $period = null
): array {
    $signals = [];

    /*
     * The periodical being judged, when the caller names one.
     *
     * This is the difference between "how is this student doing this semester"
     * and "how is this student doing in P1", and the two are not the same
     * question. A student 30% absent in P1 and 4% absent in P2 is a P1 flag and
     * a P2 clear; scoring them off the semester sum makes them 17% in both -
     * under-flagged in the periodical where they were actually in trouble, and
     * carrying a flag into the periodical where they had recovered.
     *
     * So a named periodical means that periodical's own numbers, and each
     * periodical is judged against the model's thresholds independently. The
     * absence blocks below all filter on it; see the attendance block for why
     * the rollup it already had turns out to be the right shape for this.
     *
     * Null keeps the old semester-level rollup exactly as it was.
     */
    [$gradePeriodSql, $gradePeriodParams] = api_period_filter_sql('g.period', $period, ':grade_period');
    [$finPeriodSql, $finPeriodParams]     = api_period_filter_sql('f.period', $period, ':fin_period');
    [$attPeriodSql, $attPeriodParams]     = api_period_filter_sql('period', $period, ':att_period');

    /*
     * A note that governs all three blocks below.
     *
     * A semester runs three periodicals, and grades, attendance and finance each
     * hold a row per periodical plus, on older data, one whole-semester row. The
     * three reporting modules already agree on how to turn that into one figure,
     * and each rule is the right one for what its column means:
     *
     *   attendance   SUM the periodicals    classes and absences accumulate
     *   grades       the LATEST periodical  subject counts are a standing, not a
     *                                       sum - 7 subjects do not become 21
     *   finance      the LATEST periodical  a balance is a snapshot
     *
     * and all three share one precedence: a student with ANY periodical row is
     * tracked by periodical, so their whole-semester row is history.
     *
     * This function used to ignore all of that and take whichever row sorted
     * last by primary key. That was harmless while every row was a semester row
     * and there was only one per student. The moment periodicals existed it
     * meant the engine scored a third of a semester: 132 of 587 students landed
     * in the wrong absence band, four of them genuinely over 30% absent but read
     * as 15-29% and under-flagged. The screens said one thing and the risk score
     * was computed from another.
     *
     * So each query below now mirrors its module's rule exactly. If one of those
     * rules changes, this changes with it - a student cannot be on P3 in
     * Attendance and on the old term figure in their retention case.
     */

    // ---- grades (latest periodical, as grades.php ROW_NUMBER picks) ----------
    if ($gradeRow === null) {
        $stmt = $pdo->prepare(
            "SELECT g.*, COALESCE(r.risk_level, 'Low Risk') AS remark_risk_level
               FROM grades g
          LEFT JOIN remarks r ON r.remark_id = g.remark_id
              WHERE g.student_id = :sid
                AND (:sem IS NULL OR g.semester_id = :sem)
                AND (:sy  IS NULL OR g.school_year_id = :sy)
                AND g.archived_at IS NULL"
            . ($gradePeriodSql !== '' ? ' AND ' . $gradePeriodSql : '') .
           " ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC LIMIT 1"
        );
        $stmt->execute(
            [':sid' => $studentId, ':sem' => $semesterId, ':sy' => $schoolYearId] + $gradePeriodParams
        );
        $gradeRow = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    $signals['grades.record'] = $gradeRow ? 1 : null;
    if ($gradeRow) {
        $total  = (int)($gradeRow['total_subject'] ?? 0);
        $passed = (int)($gradeRow['passed'] ?? 0);

        $signals['grades.remark_risk']   = risk_normalize_level($gradeRow['remark_risk_level'] ?? null);
        $signals['grades.failed']        = (int)($gradeRow['failed'] ?? 0);
        $signals['grades.incomplete']    = (int)($gradeRow['incomplete'] ?? 0);
        $signals['grades.no_credit']     = (int)($gradeRow['no_credit'] ?? 0);
        $signals['grades.no_grade']      = (int)($gradeRow['no_grade'] ?? 0);
        $signals['grades.total_subject'] = $total;
        $signals['grades.passed']        = $passed;
        // passed_of_subject is inert since the 2026-07-26 normalization; derive.
        $signals['grades.pass_rate']     = $total > 0 ? round($passed / $total * 100, 2) : null;
    }

    // ---- finance (latest, periodical beating a term row on the same date) ----
    $stmt = $pdo->prepare(
        "SELECT f.balance_to_data, f.balance_range, f.date
           FROM finance f
          WHERE f.student_id = :sid
            AND (:sem IS NULL OR f.semester_id = :sem)
            AND (:sy  IS NULL OR f.school_year_id = :sy)"
        . ($finPeriodSql !== '' ? ' AND ' . $finPeriodSql : '') .
   " ORDER BY f.date DESC, (f.period IS NULL) ASC, f.period DESC, f.finance_id DESC LIMIT 1"
    );
    $stmt->execute(
        [':sid' => $studentId, ':sem' => $semesterId, ':sy' => $schoolYearId] + $finPeriodParams
    );
    $financeRow = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;

    $signals['finance.record'] = $financeRow ? 1 : null;
    if ($financeRow) {
        $balance = (float)($financeRow['balance_to_data'] ?? 0);
        $signals['finance.balance_amount'] = $balance;
        $signals['finance.balance_tier']   = $financeRow['balance_range'] !== null
            ? (int)$financeRow['balance_range']
            : null;

        // A balance is only weak evidence on its own. A balance that has not
        // gone down since the previous snapshot is much stronger. Requires more
        // than one finance row per student to ever fire.
        // Same precedence on the lookback. The periodicals of one semester all
        // carry that semester's date, so `date <` steps back a whole term rather
        // than one periodical - which keeps this reading "not paid down since
        // last term" instead of quietly becoming "since last periodical".
        $prev = $pdo->prepare(
            "SELECT balance_to_data FROM finance
              WHERE student_id = :sid AND date < :d
           ORDER BY date DESC, (period IS NULL) ASC, period DESC, finance_id DESC LIMIT 1"
        );
        $prev->execute([':sid' => $studentId, ':d' => $financeRow['date']]);
        $prevBalance = $prev->fetchColumn();
        $signals['finance.balance_unchanged'] =
            ($prevBalance !== false && $prevBalance !== null && $balance >= (float)$prevBalance) ? 1 : 0;
    }

    /*
     * ---- attendance (the periodicals SUMMED, as attendance-summary.php does)
     *
     * The only one of the three that adds up, and the only one that was
     * seriously wrong before: picking one row read a third of the term's classes
     * and a third of its absences. The rate happened to survive when absences
     * were spread evenly and broke whenever they were not, which is exactly the
     * student worth catching.
     *
     * The two candidate totals are kept apart and chosen between, rather than
     * added - a student with a legacy whole-semester row AND periodicals would
     * otherwise be counted twice.
     *
     * That same shape is what makes a named periodical work without a second
     * query. Filtering the inner SELECT to period = 1 leaves one row in the
     * periodical branch, so the SUM is P1's own classes and P1's own absences
     * and the rate is P1's rate - each periodical judged against the model's
     * thresholds on its own numbers. Filtering to period IS NULL empties that
     * branch, and periodical_records = 0 sends the CASE to the whole-semester
     * row, which is the right answer for "the term row, not the periodicals".
     */
    $stmt = $pdo->prepare(
        "SELECT
            CASE WHEN g.periodical_records > 0 THEN g.periodical_classes ELSE g.semester_classes END AS total_classes_conducted,
            CASE WHEN g.periodical_records > 0 THEN g.periodical_present ELSE g.semester_present END AS present,
            CASE WHEN g.periodical_records > 0 THEN g.periodical_absent  ELSE g.semester_absent  END AS absent,
            g.any_record
           FROM (
                SELECT
                    COUNT(*) AS any_record,
                    COUNT(CASE WHEN period IS NOT NULL THEN 1 END) AS periodical_records,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN total_classes_conducted END), 0) AS periodical_classes,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN present END), 0) AS periodical_present,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN absent  END), 0) AS periodical_absent,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN total_classes_conducted END), 0) AS semester_classes,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN present END), 0) AS semester_present,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN absent  END), 0) AS semester_absent
                  FROM attendance
                 WHERE student_id = :sid
                   AND (:sem IS NULL OR semester_id = :sem)
                   AND (:sy  IS NULL OR schoolyear_id = :sy)"
        . ($attPeriodSql !== '' ? ' AND ' . $attPeriodSql : '') .
          " ) g"
    );
    $stmt->execute(
        [':sid' => $studentId, ':sem' => $semesterId, ':sy' => $schoolYearId] + $attPeriodParams
    );
    // An aggregate always returns a row, even for a student with no attendance
    // at all - COUNT over nothing is 0, not no-row. So "has a record" is the
    // count, not the presence of a row; reading it the old way would have told
    // every `missing` rule that attendance was on file for everybody.
    $attRow = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    if ($attRow !== null && (int)($attRow['any_record'] ?? 0) === 0) {
        $attRow = null;
    }

    $signals['attendance.record'] = $attRow ? 1 : null;
    if ($attRow) {
        $conducted = (int)($attRow['total_classes_conducted'] ?? 0);
        $absent    = (int)($attRow['absent'] ?? 0);
        $present   = (int)($attRow['present'] ?? 0);

        $signals['attendance.total_classes_conducted'] = $conducted;
        $signals['attendance.absent']       = $absent;
        $signals['attendance.present']      = $present;
        $signals['attendance.absent_rate']  = $conducted > 0 ? round($absent / $conducted * 100, 2) : null;
        $signals['attendance.present_rate'] = $conducted > 0 ? round($present / $conducted * 100, 2) : null;
    }

    // ---- survey -------------------------------------------------------------
    // One question matters here, and it is not scored: did the student say they
    // will enroll next term. Everything the survey used to contribute - weighted
    // per-category points, keyword matching on free text, rating scales - is
    // gone, because the office does not run the survey as a scoring instrument.
    // See risk_survey_will_enroll() for how yes and no are told apart.
    if ($submissionRow === null) {
        $stmt = $pdo->prepare(
            "SELECT ss.submission_id, ss.survey_id
               FROM survey_submission ss
               JOIN survey s ON s.survey_id = ss.survey_id
              WHERE ss.student_id = :sid
                AND ss.archived_at IS NULL
                AND (:sem IS NULL OR s.semester_id = :sem)
           ORDER BY ss.submitted_at DESC, ss.submission_id DESC LIMIT 1"
        );
        $stmt->execute([':sid' => $studentId, ':sem' => $semesterId]);
        $submissionRow = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    $signals['survey.submission'] = $submissionRow ? 1 : null;
    if ($submissionRow) {
        // Keyed to match risk_signal_key(), which strips the redundant source
        // prefix from a field_key like "survey.will_enroll".
        $signals['survey.will_enroll'] = risk_survey_will_enroll(
            $pdo,
            (int)$submissionRow['submission_id'],
            (int)$submissionRow['survey_id']
        );
    }

    return $signals;
}

/**
 * Did this student say they will enroll next term? 1 for yes, 0 for no.
 *
 * Null covers three cases that are all "the survey does not answer this": the
 * survey has no enrolment question, the student skipped it, or they answered
 * something that is neither - "I am still undecided" being the one that
 * actually occurs. Null contributes nothing rather than being counted as a no,
 * because undecided is not a refusal and treating it as one would flag every
 * student who is simply still thinking. Their standing still reads "Undecided"
 * on the migration board, which is where that answer belongs.
 *
 * The yes/no split is read from data, not from the words. survey_question_option
 * carries an enrollment_status_id - the same column the migration board already
 * trusts to turn an answer into a standing - so "Yes, but with shift course"
 * counts as a yes because it maps to To Shift, a student the college keeps. No
 * keyword matching happens here; if an option carries no mapping it implies
 * nothing, which is the correct answer for every survey that is not the
 * enrolment-intent one.
 */
function risk_survey_will_enroll(PDO $pdo, int $submissionId, int $surveyId): ?int
{
    require_once __DIR__ . '/lib/survey_enrollment_status.php';

    $option = resolve_submission_enrollment_status($pdo, $submissionId, $surveyId);
    if (!$option) {
        return null;
    }

    $statusId = (int)$option['enrollment_status_id'];
    if (in_array($statusId, RISK_SURVEY_STAYING_STATUS_IDS, true)) {
        return 1;
    }
    if (in_array($statusId, RISK_SURVEY_LEAVING_STATUS_IDS, true)) {
        return 0;
    }

    return null;
}

/**
 * Apply a model's indicators to a signal map.
 */
function risk_evaluate_signals(array $model, array $signals): array
{
    $categoryScores = [];
    $sourceScores   = [];
    $hits           = [];
    $reasons        = [];
    $total          = 0.0;

    foreach ($model['indicators'] as $indicator) {
        $key      = risk_signal_key((string)$indicator['source'], (string)$indicator['field_key']);
        $observed = $signals[$key] ?? null;

        if (!risk_indicator_matches($indicator, $observed)) {
            continue;
        }

        $points = (float)$indicator['points'];
        $code   = (string)$indicator['category_code'];
        $source = (string)$indicator['source'];

        $categoryScores[$code] = ($categoryScores[$code] ?? 0.0) + $points;
        $sourceScores[$source] = ($sourceScores[$source] ?? 0.0) + $points;
        $total += $points;

        $reason = risk_render_reason($indicator, $observed);
        if ($reason !== '') {
            $reasons[] = $reason;
        }

        $hits[] = [
            'indicator_id'   => (int)$indicator['indicator_id'],
            'category_id'    => (int)$indicator['category_id'],
            'category_code'  => $code,
            'source'         => $source,
            'field_key'      => (string)$indicator['field_key'],
            'observed_value' => $observed === null ? null : (string)$observed,
            'points_awarded' => $points,
            'reason'         => $reason,
        ];
    }

    $level = risk_level_for_score($total, $model);

    // The existing retention_case columns predate categories; keep them
    // populated so nothing downstream has to change at once.
    $academicScore = $categoryScores['academic'] ?? 0.0;
    $surveyScore   = $sourceScores['survey'] ?? 0.0;

    return [
        'model_id'            => (int)$model['model_id'],
        'evaluation_score'    => round($total, 2),
        'category_scores'     => $categoryScores,
        'source_scores'       => $sourceScores,
        'combined_risk_level' => $level,
        'academic_risk_level' => risk_level_for_score($academicScore, $model),
        'survey_risk_level'   => risk_level_for_score($surveyScore, $model),
        'evaluation_reason'   => implode(' ', array_values(array_unique($reasons))),
        'hits'                => $hits,
    ];
}

/**
 * Indicator field_key may or may not repeat its source as a prefix — survey
 * rules read naturally as "survey.will_enroll". Normalise both to one lookup key.
 */
function risk_signal_key(string $source, string $fieldKey): string
{
    $prefix = $source . '.';
    if (strpos($fieldKey, $prefix) === 0) {
        $fieldKey = substr($fieldKey, strlen($prefix));
    }
    return $source . '.' . $fieldKey;
}

function risk_indicator_matches(array $indicator, $observed): bool
{
    $operator = (string)$indicator['operator'];

    if ($operator === 'missing') {
        return $observed === null || $observed === '' || $observed === 0 || $observed === '0';
    }
    if ($operator === 'present') {
        return !($observed === null || $observed === '' || $observed === 0 || $observed === '0');
    }
    if ($observed === null || $observed === '') {
        return false;
    }

    // Text comparison when the rule carries a value_text (e.g. remark_risk).
    if ($indicator['value_text'] !== null && $indicator['value_text'] !== '') {
        $a = strtolower(trim((string)$observed));
        $b = strtolower(trim((string)$indicator['value_text']));
        if ($operator === 'eq')  return $a === $b;
        if ($operator === 'neq') return $a !== $b;
        return false;
    }

    if (!is_numeric($observed)) {
        return false;
    }
    $value = (float)$observed;
    $min   = $indicator['value_min'] !== null ? (float)$indicator['value_min'] : null;
    $max   = $indicator['value_max'] !== null ? (float)$indicator['value_max'] : null;

    switch ($operator) {
        case 'gte':     return $min !== null && $value >= $min;
        case 'gt':      return $min !== null && $value >  $min;
        case 'lte':     return $min !== null && $value <= $min;
        case 'lt':      return $min !== null && $value <  $min;
        case 'eq':      return $min !== null && abs($value - $min) < 0.0001;
        case 'neq':     return $min !== null && abs($value - $min) >= 0.0001;
        case 'between': return $min !== null && $max !== null && $value >= $min && $value <= $max;
    }
    return false;
}

function risk_render_reason(array $indicator, $observed): string
{
    $template = trim((string)($indicator['reason_template'] ?? ''));
    if ($template === '') {
        $template = (string)$indicator['label'];
    }
    return str_replace(
        ['{value}', '{label}'],
        [$observed === null ? '' : (string)$observed, (string)$indicator['label']],
        $template
    );
}

function risk_level_for_score(float $score, array $model): string
{
    if ($score >= (float)$model['high_threshold']) {
        return 'high';
    }
    if ($score >= (float)$model['moderate_threshold']) {
        return 'moderate';
    }
    return 'low';
}

function risk_normalize_level($value): string
{
    $text = strtolower(trim((string)$value));
    if (strpos($text, 'high') !== false)     return 'high';
    if (strpos($text, 'moderate') !== false) return 'moderate';
    if (strpos($text, 'medium') !== false)   return 'moderate';
    return 'low';
}

/**
 * Replace a case's stored hits. Called inside the caller's transaction.
 */
function risk_persist_case_hits(PDO $pdo, int $caseId, array $hits): void
{
    if (!risk_model_tables_exist($pdo)) {
        return;
    }

    $pdo->prepare("DELETE FROM retention_case_indicator_hit WHERE case_id = :cid")
        ->execute([':cid' => $caseId]);

    if (!$hits) {
        return;
    }

    $insert = $pdo->prepare(
        "INSERT INTO retention_case_indicator_hit
            (case_id, indicator_id, category_id, source, field_key,
             observed_value, points_awarded, reason)
         VALUES (:cid, :iid, :catid, :src, :fk, :obs, :pts, :reason)"
    );
    foreach ($hits as $hit) {
        $insert->execute([
            ':cid'    => $caseId,
            ':iid'    => $hit['indicator_id'] ?: null,
            ':catid'  => $hit['category_id'],
            ':src'    => $hit['source'],
            ':fk'     => $hit['field_key'],
            ':obs'    => $hit['observed_value'] !== null ? mb_substr((string)$hit['observed_value'], 0, 255) : null,
            ':pts'    => $hit['points_awarded'],
            ':reason' => $hit['reason'] !== '' ? mb_substr((string)$hit['reason'], 0, 255) : null,
        ]);
    }
}

}
