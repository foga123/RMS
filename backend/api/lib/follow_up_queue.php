<?php
/**
 * Who needs calling, and why.
 *
 * The follow-up queue used to be the enrollment_status table: every student with
 * a non-approved standing. That table holds 20 rows against 509 students, so the
 * board it fed was empty for reasons that had nothing to do with whether a
 * student was in trouble — a record only exists once somebody has already made
 * a decision about them, which is the wrong end of the process to start from.
 *
 * It was then driven from retention_case.combined_risk_level, which had the same
 * shape of problem one level up: a case row only exists once somebody has pressed
 * Run Evaluation. On 2026-09-18 that was 3 students out of 2,776, so the priority
 * band held ONE student while 2,762 sat in the survey band. The queue was again
 * describing who had been processed rather than who was in trouble.
 *
 * It is now driven from the PDO segment matrix — pdo_classify_student(), the same
 * engine behind the Potential Drop Out board, the case board, the contact
 * workspace and the three record modules' `pdo=` filter. Every enrolled student
 * gets a priority from their own grades, attendance and balance, whether or not
 * anyone has opened a case on them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BANDS ARE NOW P1-P4
 *
 * The board this feeds already SHOWED Priority 1-4 badges while its membership
 * was decided by high/moderate/low underneath, so a student could read P1 on the
 * row and still be absent from the priority queue. Two scales for one question
 * is how somebody ends up working the wrong list — the same reason the case
 * board and the assignment badges moved to P1-4 before this file did.
 *
 * So the queue token IS the priority: '1', '2', '3', '4'. A caller picks the
 * band they are working rather than accepting one hard-coded "at risk" cut, and
 * the counts beside each tab say how many are in it. Measured on the 2,776
 * roster: P1 835, P2 689, P3 1,252, P4 0.
 *
 * SURVEY stays a band of its own rather than becoming a fifth priority. Survey
 * non-response is a different question from academic risk — it covers most of
 * the cohort, which is why the `survey.submission` risk indicator was
 * deactivated after firing for 299 of 301 students. Folded into a priority band
 * it would bury the students who need a phone call under the ones who merely
 * have not filled in a form.
 *
 * It excludes anyone already in a calling band, which is the rule it had under
 * the old scale and is worth keeping: a student on two lists reads as two jobs,
 * and the caller who works both rings them twice. So the survey band is "no
 * submission, and not P1 or P2" — 1,247 of the 2,762 who have not submitted.
 *
 * ---------------------------------------------------------------------------
 * WHY MEMBERSHIP IS DECIDED IN PHP, NOT IN SQL
 *
 * The matrix is five branches derived from a 48-row sheet, and pdo_priority_lib
 * exists precisely so nothing re-derives them. A WHERE clause that reproduced
 * them would be a sixth copy that quietly disagrees with the board about the
 * same student the first time a threshold is edited in pdo_setting.
 *
 * So the SQL narrows to what SQL can answer — not archived, not approved,
 * in the caller's scope, and (for the survey band) no submission — and
 * follow_up_queue_apply() classifies the rows it returns and filters from
 * there. This is the same load-then-classify shape pdo_priority.php and
 * fetch_cases_payload() already use, and it is why neither of them pages in
 * SQL either.
 *
 * Both bands are scoped to the caller's student type upstream, so an SSP Caller
 * only ever sees Nonstar and a KSH Coach only Star.
 */

require_once __DIR__ . '/../pdo_priority_lib.php';

const FOLLOW_UP_QUEUE_SURVEY   = 'survey';
const FOLLOW_UP_QUEUE_ALL      = 'all';

/**
 * The legacy token, kept so a client that has not been updated still works.
 *
 * It means "the bands that used to be moderate-or-high", which on the priority
 * scale is P1 and P2 — the top two of four, as moderate and high were the top
 * two of three. A caller sending it gets a usable list rather than an error.
 */
const FOLLOW_UP_QUEUE_PRIORITY = 'priority';

/** What `priority` resolves to, and the default band when nothing is asked for. */
const FOLLOW_UP_PRIORITY_LEVELS = [1, 2];

/** The four bands a caller can actually pick. */
const FOLLOW_UP_QUEUE_LEVELS = [1, 2, 3, 4];

function follow_up_queue_normalize(?string $value): string
{
    $token = strtolower(trim((string)$value));

    if ($token === FOLLOW_UP_QUEUE_SURVEY || $token === FOLLOW_UP_QUEUE_ALL) {
        return $token;
    }
    if (in_array($token, ['1', '2', '3', '4'], true)) {
        return $token;
    }

    // P1 first because it is the answer to "who do I ring today" — the band the
    // sheet routes to College. `priority` lands here too, by design.
    return FOLLOW_UP_QUEUE_PRIORITY;
}

/** The priority levels a queue token selects, or [] when it is not a priority band. */
function follow_up_queue_levels(string $queue): array
{
    $token = follow_up_queue_normalize($queue);

    if ($token === FOLLOW_UP_QUEUE_PRIORITY) return FOLLOW_UP_PRIORITY_LEVELS;
    if (in_array($token, ['1', '2', '3', '4'], true)) return [(int)$token];

    return [];
}

/**
 * The joins that carry a student's survey state and their last evaluation.
 *
 * The retention_case join stays: risk_level, risk_score and risk_reason are
 * still SELECTed and still shown, because the evaluation reason is the sentence
 * a caller reads before dialling. What changed is that they no longer decide
 * membership — a student with no case at all is now classified from their own
 * records rather than defaulting to 'low' and falling out of the priority band.
 *
 * Latest case per student rather than any case: a student re-evaluated after an
 * intervention has more than one row, and the stale one must not be the one
 * shown. Both joins are LEFT so a student with neither a case nor a submission
 * still reaches the WHERE clause.
 */
function follow_up_queue_join_sql(string $studentAlias = 'st'): string
{
    return "
            LEFT JOIN (
                SELECT rc.student_id, rc.combined_risk_level, rc.evaluation_score, rc.evaluation_reason
                FROM retention_case rc
                INNER JOIN (
                    SELECT student_id, MAX(case_id) AS latest_case_id
                    FROM retention_case GROUP BY student_id
                ) rcl ON rcl.latest_case_id = rc.case_id
            ) risk ON risk.student_id = {$studentAlias}.student_id
            LEFT JOIN (
                SELECT DISTINCT student_id FROM survey_submission WHERE archived_at IS NULL
            ) sv ON sv.student_id = {$studentAlias}.student_id";
}

/**
 * Columns the join above makes available. Kept beside it so they cannot drift.
 *
 * `queue_band` is no longer computed here — it depends on the priority, which
 * SQL cannot work out. follow_up_queue_apply() sets it on the row instead.
 */
function follow_up_queue_select_sql(): string
{
    return "
                COALESCE(risk.combined_risk_level, 'low') AS risk_level,
                COALESCE(risk.evaluation_score, 0) AS risk_score,
                risk.evaluation_reason AS risk_reason,
                CASE WHEN sv.student_id IS NULL THEN 1 ELSE 0 END AS missing_survey";
}

/**
 * The WHERE fragment for one band, and its parameters.
 *
 * Only the survey band can be decided here, because only it asks a question
 * about a row that exists. The priority bands narrow nothing in SQL and are
 * filtered by follow_up_queue_apply() after classification — calling one
 * without the other returns every student in scope, so the two go together.
 *
 * `all` is every student the queue can say something about, which after this
 * change is everyone enrolled: every student has a priority. It is still not
 * the student list, because the caller's own scope and the approved-decision
 * exclusion are applied by the query this fragment goes into.
 */
function follow_up_queue_where(string $queue): array
{
    $noSurvey = 'sv.student_id IS NULL';

    switch (follow_up_queue_normalize($queue)) {
        case FOLLOW_UP_QUEUE_SURVEY:
            return ['sql' => "({$noSurvey})", 'params' => []];

        // Priority bands and `all` alike: SQL cannot decide these, so it must
        // not pretend to. 1=1 keeps the clause syntactically whole for the
        // callers that interpolate it into a bigger WHERE.
        default:
            return ['sql' => '(1 = 1)', 'params' => []];
    }
}

/**
 * Classify the fetched rows, annotate them, and keep the band that was asked for.
 *
 * Three queries for the whole batch then the shared classifier — never one
 * lookup per student, which is what turns a 2,776-row board into 8,000
 * round trips.
 *
 * Rows come back with `priority`, `priority_label`, `priority_owner`, `segment`
 * and `queue_band` set, so a caller reads the same P1-4 on this board as on the
 * PDO list and the case board.
 */
function follow_up_queue_apply(PDO $pdo, array $rows, string $queue, ?int $semesterId = null, ?int $schoolYearId = null, $period = null): array
{
    if (empty($rows)) return [];

    $studentIds = array_map(static function (array $row): int {
        return (int)($row['student_id'] ?? 0);
    }, $rows);

    $settings = pdo_settings($pdo);
    $signals = pdo_load_signals($pdo, $studentIds, $semesterId, $schoolYearId, $period);

    $wanted = follow_up_queue_levels($queue);
    $token = follow_up_queue_normalize($queue);

    $out = [];
    foreach ($rows as $row) {
        $studentId = (int)($row['student_id'] ?? 0);
        $classified = pdo_classify_student(
            ['student_id' => $studentId],
            $signals['grades'][$studentId] ?? null,
            $signals['attendance'][$studentId] ?? null,
            $signals['finance'][$studentId] ?? null,
            $settings
        );

        $row['priority'] = $classified['priority'];
        $row['priority_label'] = $classified['priority_label'];
        $row['priority_owner'] = $classified['owner'];
        $row['segment'] = $classified['segment'];
        /*
         * The band this student sits in on their own. A student with no survey
         * AND a priority is reported as their priority: the tabs are what
         * separates the two lists, and naming a row twice reads as two jobs.
         */
        $row['queue_band'] = (string)$classified['priority'];

        if ($token === FOLLOW_UP_QUEUE_ALL) {
            $out[] = $row;
            continue;
        }
        if ($token === FOLLOW_UP_QUEUE_SURVEY) {
            /*
             * Both halves of the band tested here, including the missing
             * submission the SQL has usually already required.
             *
             * Re-checking it looks redundant and is not: the WHERE clause is
             * the caller's to apply, and a caller that fetched a wider set --
             * find_student_row() asks for FOLLOW_UP_QUEUE_ALL, the write path
             * re-reads one row -- would otherwise get every non-calling
             * student back as "no survey yet". A band that is only correct
             * when someone else remembered a clause is a band that breaks the
             * first time it is reused.
             *
             * The second half drops anyone ALSO in a calling band, which is
             * the rule the old risk-scale version had and is worth keeping: a
             * student on two lists reads as two jobs, and the caller working
             * both rings them twice.
             */
            if ((int)($row['missing_survey'] ?? 0) !== 1) {
                continue;
            }
            if (in_array($classified['priority'], FOLLOW_UP_PRIORITY_LEVELS, true)) {
                continue;
            }
            $row['queue_band'] = FOLLOW_UP_QUEUE_SURVEY;
            $out[] = $row;
            continue;
        }
        if (in_array($classified['priority'], $wanted, true)) {
            $out[] = $row;
        }
    }

    return follow_up_queue_sort($out);
}

/**
 * Worst first, then whatever the caller's query already ordered by.
 *
 * A stable sort on priority alone: usort is not stable before PHP 8.0, so the
 * index is carried as the tie-break rather than trusted. That keeps the
 * ORDER BY the SQL applied — fewest assignments first on the board, last name
 * on the workspace — intact inside each band.
 */
function follow_up_queue_sort(array $rows): array
{
    $indexed = [];
    foreach ($rows as $i => $row) {
        $indexed[] = [$i, $row];
    }

    usort($indexed, static function (array $a, array $b): int {
        $byPriority = ($a[1]['priority'] ?? 9) <=> ($b[1]['priority'] ?? 9);
        return $byPriority !== 0 ? $byPriority : ($a[0] <=> $b[0]);
    });

    return array_map(static function (array $pair) {
        return $pair[1];
    }, $indexed);
}

/**
 * Worst first, then alphabetical.
 *
 * Priority is no longer part of this: it is not a column, so it cannot be an
 * ORDER BY, and follow_up_queue_sort() applies it after classification. What
 * stays here is the tie-break WITHIN a priority — the evaluation score where
 * there is one, then the name — which SQL can still do and which keeps the
 * order deterministic before the band sort runs over it.
 */
function follow_up_queue_order_sql(string $studentAlias = 'st'): string
{
    return "risk.evaluation_score DESC,
            {$studentAlias}.last_name ASC,
            {$studentAlias}.first_name ASC,
            {$studentAlias}.student_id ASC";
}

/**
 * Per-band counts for the caller's tabs, scoped to one student type.
 *
 * Classified in PHP for the same reason membership is: the counts have to agree
 * with the rows, and a SQL count of a rule PHP applies is a second
 * implementation that disagrees the first time a threshold moves.
 *
 * Returns a count per priority level plus the survey band, and `priority` —
 * the legacy key, still the P1+P2 total — so a client that has not been updated
 * keeps rendering a number rather than undefined.
 */
function follow_up_queue_counts(PDO $pdo, ?string $studentType = null, array $visibility = ['sql' => '', 'params' => []]): array
{
    $typeWhere = '';
    $params = [];
    if ($studentType !== null && $studentType !== '') {
        $typeWhere = ' AND st.`star e-profile` = :student_type';
        $params[':student_type'] = $studentType;
    }

    /*
     * The SAME scope the rows are fetched with, or the count describes a
     * different queue from the one underneath it.
     *
     * This used to take the student-type scope and nothing else, while
     * student_contact_queue_rows() also narrowed by department or by SSP
     * assignment. So the workspace tab read "Needs a call 451" above a table
     * holding 31 -- the 451 counted every at-risk student in the college, the
     * 31 were the ones actually assigned to that caller. Pressing Refresh
     * changed nothing, because nothing was broken about the fetch; the badge
     * was answering a question nobody had asked.
     *
     * Passed in rather than resolved here: student_contact_visibility_clause()
     * lives in the workflow library, and a queue helper that reached into it
     * would tie this file to a module it otherwise knows nothing about. The
     * caller that has an $access already supplies it; the one that genuinely
     * wants the unscoped total -- ssp_assignment.php, where a coordinator is
     * deciding who to hand out -- passes nothing and is unchanged.
     */
    $visibilitySql = (string)($visibility['sql'] ?? '');
    foreach (($visibility['params'] ?? []) as $name => $value) {
        $params[$name] = $value;
    }

    /*
     * `course` is joined for the department branch of that clause, which names
     * c.department_id. Harmless when no clause is passed -- a LEFT JOIN on the
     * student's own course cannot drop or duplicate a student row.
     */
    $sql = "SELECT st.student_id,
                   CASE WHEN sv.student_id IS NULL THEN 1 ELSE 0 END AS missing_survey
            FROM student st
            LEFT JOIN course c ON c.course_id = st.course_id"
            . follow_up_queue_join_sql('st') . "
            WHERE st.archived_at IS NULL{$typeWhere}{$visibilitySql}";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $counts = ['1' => 0, '2' => 0, '3' => 0, '4' => 0, FOLLOW_UP_QUEUE_SURVEY => 0];

    if (!empty($rows)) {
        $studentIds = array_map(static function (array $row): int {
            return (int)($row['student_id'] ?? 0);
        }, $rows);
        $settings = pdo_settings($pdo);
        $signals = pdo_load_signals($pdo, $studentIds);

        foreach ($rows as $row) {
            $studentId = (int)($row['student_id'] ?? 0);
            $classified = pdo_classify_student(
                ['student_id' => $studentId],
                $signals['grades'][$studentId] ?? null,
                $signals['attendance'][$studentId] ?? null,
                $signals['finance'][$studentId] ?? null,
                $settings
            );
            $counts[(string)$classified['priority']] += 1;
            /*
             * Same exclusion follow_up_queue_apply() makes, or the tab says a
             * number the list under it does not hold. A student in a calling
             * band is counted there and not here.
             */
            if ((int)($row['missing_survey'] ?? 0) === 1
                && !in_array($classified['priority'], FOLLOW_UP_PRIORITY_LEVELS, true)) {
                $counts[FOLLOW_UP_QUEUE_SURVEY] += 1;
            }
        }
    }

    $counts[FOLLOW_UP_QUEUE_PRIORITY] = array_sum(array_map(
        static function (int $level) use ($counts): int {
            return $counts[(string)$level] ?? 0;
        },
        FOLLOW_UP_PRIORITY_LEVELS
    ));
    // Every student has exactly one priority, so the four bands are the whole
    // population - the "all students" view the assignment board offers.
    $counts[FOLLOW_UP_QUEUE_ALL] = array_sum(array_map(
        static function (int $level) use ($counts): int {
            return $counts[(string)$level] ?? 0;
        },
        FOLLOW_UP_QUEUE_LEVELS
    ));

    return $counts;
}
