<?php
/**
 * The PDO (Potential Drop Out) prioritization list, from section 2 of the
 * RETENTION & MIGRATION sheet.
 *
 * The sheet gives a 48-row table mapping every combination of
 * (attendance status, grade colour, balance band) to a priority level and an
 * owning team. That table is reproduced here as five rules rather than as
 * forty-eight rows, because forty-eight rows of data that encode five decisions
 * hide the decisions. pdo_priority_lib.test verifies the five rules against all
 * forty-eight, so the reduction is checked rather than asserted.
 *
 * The classification thresholds are NOT here: the sheet never defines what makes
 * a student's grades Green, or what separates Attending from SLIP, and those are
 * the school's policy. They live in the pdo_setting table.
 */

// api_period_filter_sql(), used by pdo_load_signals() to answer for one
// periodical rather than the whole term. require_once rather than relying on
// the caller: pdo_priority.php does not load periodic_lib.php, and a library
// that only works when something else happens to have been included first is a
// library that breaks the next time somebody includes it somewhere new.
require_once __DIR__ . '/periodic_lib.php';
// The balance bands. Shared with the finance importer so the band a student is
// shown in here is the band their record was filed under.
require_once __DIR__ . '/lib/finance_bands.php';

/**
 * The three bands that mean "something is wrong with this student".
 *
 * Every student gets a priority, so being on the board is not a distinction:
 * Priority 4 is Attending | Green | No Balance, the safest standing there is.
 * These three are what somebody means by "the potential drop outs", and the
 * list is written here once because four callers had it as a literal.
 */
const PDO_FLAGGED_PRIORITIES = [1, 2, 3];

/** Grade colours, worst first. 'no_data' is not a colour but is what the sheet calls it. */
const PDO_GRADE_NO_DATA = 'no_data';
const PDO_GRADE_RED = 'red';
const PDO_GRADE_YELLOW = 'yellow';
const PDO_GRADE_GREEN = 'green';

const PDO_GRADE_LABELS = [
    PDO_GRADE_NO_DATA => 'No Grade Data',
    PDO_GRADE_RED => 'Red',
    PDO_GRADE_YELLOW => 'Yellow',
    PDO_GRADE_GREEN => 'Green',
];

const PDO_ATTENDING = 'attending';
const PDO_SLIP = 'slip';
const PDO_ATTENDANCE_LABELS = [PDO_ATTENDING => 'Attending', PDO_SLIP => 'SLIP'];

/*
 * Not a third status -- there are two, and the matrix has 48 rows because of
 * it. This is what the label says when the two do not apply because nothing
 * has been recorded. See pdo_attendance_label().
 */
const PDO_ATTENDANCE_NO_DATA_LABEL = 'No attendance data';

/**
 * Balance bands as the sheet writes them.
 *
 * Six bands where this database stores four. That mismatch is deliberately NOT
 * reconciled, because checking all 48 rows shows the band never changes the
 * priority beyond "No Balance" versus anything else - Attending|Green with a
 * 1-3K balance and with a 7.5K+ balance are both Priority 3. The bands are
 * computed here for display and for the segment label only.
 */
const PDO_BALANCE_NONE = 'no_balance';
const PDO_BALANCE_NO_DATA = 'no_data';

const PDO_BALANCE_LABELS = [
    PDO_BALANCE_NONE => 'No Balance',
    'band_1_3k' => '1 to 3K',
    'band_3_5k' => '3K to 5K',
    'band_5_75k' => '5K to 7.5K',
    'band_75k_up' => '7.5K and Up',
    PDO_BALANCE_NO_DATA => 'No Data',
];

/** Priority levels and the team that owns each, exactly as the sheet names them. */
const PDO_PRIORITY_OWNERS = [
    1 => 'College',
    2 => 'Coaches',
    3 => 'Coaches',
    4 => 'Coaches',
];

/**
 * The thresholds, with the seeded defaults as the fallback.
 *
 * Carries the balance bands too, under 'balance_bands'. They are not a
 * pdo_setting row - they live on the finance rows of `status` - but every
 * caller that classifies a student already fetches this array and passes it to
 * pdo_classify_student(), so putting the ladder in here is what lets seven call
 * sites pick up an edited band without one of them changing.
 */
function pdo_settings(PDO $pdo): array
{
    $defaults = [
        'grade_yellow_max_problems' => 1,
        /*
         * The absence rate at which a student counts as slipping.
         *
         * An ABSENCE rate, not the present rate this used to hold. The two are
         * only each other's complement when present + absent = classes
         * conducted, which the importer warns about but does not enforce - a row
         * with unrecorded classes makes "70% present" and "30% absent" two
         * different students. The risk engine's own rule is written on the
         * absence rate, so this is too, and the two now agree by construction
         * rather than by arithmetic that holds most of the time.
         *
         * 30 matches the risk indicator "Absent rate 30% or more".
         */
        'attendance_slip_min_absent_rate' => 30,
        'attendance_missing_is_slip' => 0,
    ];

    try {
        $rows = $pdo->query('SELECT setting_key, setting_value FROM pdo_setting')->fetchAll(PDO::FETCH_KEY_PAIR);
    } catch (Throwable $e) {
        // The table not existing is not a reason to fail the page. The defaults
        // below are the same values the migration seeds, so the screen behaves
        // identically until somebody tunes it.
        $rows = [];
    }

    foreach ($defaults as $key => $default) {
        if (isset($rows[$key]) && is_numeric($rows[$key])) {
            $defaults[$key] = (float)$rows[$key];
        }
    }

    $defaults['balance_bands'] = finance_bands_load($pdo);

    return $defaults;
}

/**
 * The colour of a student's grades.
 *
 * A "problem subject" is one that is failed, incomplete, no-credit or no-grade.
 * Zero problems is Green, up to the configured count is Yellow, beyond it is
 * Red - the same banding autoRemarkFromBreakdown() in GradesPage.jsx uses to
 * write the remark stored against the very same row, so the colour here and the
 * remark there cannot disagree.
 *
 * No row at all, or a row covering no subjects, is No Grade Data rather than
 * Green. A student nobody has graded is the most urgent case on the sheet
 * (Priority 1, College), not the safest - and treating an absent record as a
 * clean one is exactly the mistake that would bury them.
 */
function pdo_grade_colour(?array $grade, array $settings): string
{
    if ($grade === null) {
        return PDO_GRADE_NO_DATA;
    }

    $totalSubject = (int)($grade['total_subject'] ?? 0);
    if ($totalSubject <= 0) {
        return PDO_GRADE_NO_DATA;
    }

    $problems = (int)($grade['failed'] ?? 0)
        + (int)($grade['incomplete'] ?? 0)
        + (int)($grade['no_credit'] ?? 0)
        + (int)($grade['no_grade'] ?? 0);

    if ($problems <= 0) {
        return PDO_GRADE_GREEN;
    }
    if ($problems <= (int)$settings['grade_yellow_max_problems']) {
        return PDO_GRADE_YELLOW;
    }
    return PDO_GRADE_RED;
}

/**
 * Whether the student is still attending.
 *
 * Absence percentage against a configured ceiling. A student with no attendance
 * record counts as Attending unless the setting says otherwise, because an
 * absent record is a statement about what the registrar has uploaded, not about
 * whether the student came to class.
 *
 * Reads `absent`, not `present`. It used to test the present rate against a
 * floor of 50, which is the same test only when present + absent equals the
 * classes conducted - and attendance-import.php warns about rows where it does
 * not rather than rejecting them. On such a row the two readings name different
 * students, and the one the office means is the one about absences. Writing it
 * this way also puts the board on the same measure as the risk engine's
 * "Absent rate 30% or more", so a student cannot be SLIP on one screen and
 * within range on the other.
 */
function pdo_attendance_status(?array $attendance, array $settings): string
{
    $missingIsSlip = (int)$settings['attendance_missing_is_slip'] === 1;

    if ($attendance === null) {
        return $missingIsSlip ? PDO_SLIP : PDO_ATTENDING;
    }

    $conducted = (int)($attendance['total_classes_conducted'] ?? 0);
    if ($conducted <= 0) {
        return $missingIsSlip ? PDO_SLIP : PDO_ATTENDING;
    }

    $absentRate = ((int)($attendance['absent'] ?? 0) / $conducted) * 100;
    return $absentRate >= (float)$settings['attendance_slip_min_absent_rate'] ? PDO_SLIP : PDO_ATTENDING;
}

/**
 * Whether anything about this student's attendance is actually on record.
 *
 * Separate from pdo_attendance_status() on purpose. That function answers a
 * POLICY question -- "does the matrix treat this student as attending" -- and
 * `attendance_missing_is_slip` deliberately lets the College answer it either
 * way for a student nobody has recorded. This answers a question of FACT, and
 * no setting can change it.
 *
 * A row summing to zero conducted classes counts as no record, the same way
 * pdo_attendance_status() treats it: an import that filed a student with no
 * meetings has told us nothing about whether they came to class.
 */
function pdo_attendance_has_record(?array $attendance): bool
{
    return $attendance !== null && (int)($attendance['total_classes_conducted'] ?? 0) > 0;
}

/**
 * What the screen says about attendance -- which is not always what the
 * matrix decided.
 *
 * Every student with no attendance row read "Attending", and it is the one
 * word on the board that sounds like good news. With the calendar on P2 and
 * attendance imported only for P1, that was 2,775 of 2,776 students being
 * told the registrar had confirmed they were coming to class. Grades and
 * balance both already say "No Grade Data" and "No Data" in exactly this
 * situation; attendance was the only one of the three with no word for it.
 *
 * When the College has set missing-is-SLIP, the classification still is SLIP
 * and the label says so -- but it also says the flag came from an absent
 * record rather than from absences, because those are different conversations
 * to have with the student.
 *
 * pdo_segment_label() is NOT changed to match. The segment is the sheet's own
 * vocabulary ("Attending | Green | No Balance"), it is what pdo_matrix_check
 * pins all 48 rows against, and the sheet has exactly two attendance values.
 * This is display text; that is a classification.
 */
function pdo_attendance_label(string $status, ?array $attendance, array $settings = []): string
{
    if (pdo_attendance_has_record($attendance)) {
        return PDO_ATTENDANCE_LABELS[$status] ?? $status;
    }

    return (int)($settings['attendance_missing_is_slip'] ?? 0) === 1
        ? 'SLIP - no attendance recorded'
        : PDO_ATTENDANCE_NO_DATA_LABEL;
}

/**
 * How severe attendance is, in the same three words grades and balance use.
 *
 * Null when nothing is recorded, so the chip renders through the same "no
 * record" branch as an ungraded student instead of being painted green. The
 * browser used to decide this from `total_classes_conducted === null`, which
 * is the raw column and reads 0 -- not null -- for a row that was imported
 * with no meetings in it.
 */
function pdo_attendance_colour(string $status, ?array $attendance): ?string
{
    if (!pdo_attendance_has_record($attendance)) {
        return null;
    }
    return $status === PDO_SLIP ? 'red' : 'green';
}
/**
 * Which balance band a student sits in.
 *
 * No finance row is No Data, which the sheet groups with "owes something"
 * rather than with No Balance - a student nobody has billed is not a student
 * known to owe nothing.
 *
 * The cut-offs come from $settings['balance_bands'], which pdo_settings() reads
 * off the finance rows of `status` - the same ladder the importer files a
 * balance under. They used to be written out here as a second copy of the
 * importer's, agreeing by a test rather than by construction.
 *
 * $settings is optional so the function stays callable without a database, as
 * the matrix tests call it. Without it the built-in ladder answers, which is
 * the ladder the migration seeds, so the two only differ once somebody has
 * actually edited a band.
 */
function pdo_balance_band(?array $finance, array $settings = []): string
{
    if ($finance === null || $finance['balance_to_data'] === null) {
        return PDO_BALANCE_NO_DATA;
    }

    $bands = $settings['balance_bands'] ?? finance_bands_defaults();
    $band = finance_band_for((float)$finance['balance_to_data'], $bands);

    // Uncovered is No Data rather than No Balance: the ladder could not say
    // what this student owes, which is not the same as saying they owe nothing.
    return $band === null ? PDO_BALANCE_NO_DATA : $band['key'];
}

/**
 * The words for a band key.
 *
 * Prefers the ladder, so a band renamed in Status Management prints its new
 * name here. PDO_BALANCE_LABELS remains the answer for the two keys that are
 * not bands - No Data - and for a ladder that has not been loaded.
 */
/**
 * How severe a balance is, in the same three words grades use.
 *
 * `grade_colour` is green/yellow/red and every screen maps it through one
 * tone table. A balance had no equivalent, so the chips beside it were drawn
 * from the band key with a two-way test -- no_balance was green and every
 * other band, from PHP 1 to PHP 80,000, was the same amber. A ladder with
 * five rungs rendered as two.
 *
 * Derived from the band's POSITION in the ladder, never from its name or its
 * numbers: Status Management can rename "7.5K and Up" or move every cut-off,
 * and the bottom rung stays green while the top stays red. Hardcoding either
 * name is the bug finance_band_key_for() already exists to avoid.
 *
 * Null for no_data, matching grade_colour, which is null when no grades have
 * been uploaded -- so both chips render "no record" through the same branch.
 */
function pdo_balance_colour(string $band, array $settings = []): ?string
{
    if ($band === PDO_BALANCE_NO_DATA) {
        return null;
    }

    $bands = $settings['balance_bands'] ?? finance_bands_defaults();
    $bands = finance_bands_sort($bands);
    if (!$bands) {
        return null;
    }

    $keys = array_map(static fn(array $b): string => (string)($b['key'] ?? ''), $bands);
    $index = array_search($band, $keys, true);
    if ($index === false) {
        return null;
    }

    // The bottom rung is owing nothing, the top rung is owing the most, and
    // everything between is the one middle state -- three, as grades have.
    if ($index === 0) {
        return 'green';
    }
    return $index === count($bands) - 1 ? 'red' : 'yellow';
}
function pdo_balance_label(string $band, array $settings = []): string
{
    foreach ($settings['balance_bands'] ?? [] as $candidate) {
        if ($candidate['key'] === $band) {
            return (string)$candidate['label'];
        }
    }
    return PDO_BALANCE_LABELS[$band] ?? ucwords(str_replace('_', ' ', $band));
}

/**
 * The sheet's 48-row matrix, as the four rules it now contains.
 *
 * Order matters and is the order the sheet reads in:
 *   1. Still attending and owing nothing is the safest square on the board -
 *      Priority 4 - whatever the grades say. Note this beats Red: an attending
 *      student with no balance and bad marks is a teaching problem, not a
 *      retention one.
 *   2-4. Otherwise the grade colour decides, Red escalating to College.
 *
 * WHERE THIS DEPARTS FROM THE SHEET, AND WHY (changed 2026-09-12)
 *
 * The sheet has a fifth rule above these: No Grade Data outranks everything and
 * lands on Priority 1, on all twelve of its rows. That is a defensible reading
 * of RISK - an unassessed student is not a safe one - and it was wrong as a
 * WORK QUEUE, which is the only thing this number is used for. During the
 * encoding fortnight it put entire departments into P1 at once: on the board
 * checked the day before this change, all 252 students of one department were
 * Priority 1 and every one of them for want of an encoded grade, with not a
 * single failing student among them. A queue that says "call all 252" says
 * nothing.
 *
 * So the absence of a grade is no longer evidence of risk. It is not treated as
 * safety either: the other two signals still decide, which means an unassessed
 * student who has stopped attending or owes money still lands on the list on
 * that evidence - Priority 3 - rather than being excused by a missing grade.
 * Only "attending, owes nothing, not yet graded" now reads as Priority 4.
 *
 * pdo_matrix_check.php carries the twelve changed rows, so the sheet and the
 * code disagree in exactly one documented place rather than silently.
 *
 * Returns [priority, owner].
 */
function pdo_priority_for(string $attendance, string $grade, string $balance): array
{
    /*
     * Nothing is known about this student, so nothing is claimed about them.
     *
     * Dropping the No Grade Data rule above was not enough on its own. A
     * missing finance ROW is not the same value as a zero balance - `no_data`
     * against `no_balance` - so an attending student with no grades and no
     * finance record failed the "attending and owes nothing" test and came out
     * Priority 3: still flagged, by a second reporting gap standing in for
     * evidence. On the board checked the day this changed, that was all 252
     * students of a department, every one of them `attending | no_data |
     * no_data`.
     *
     * Deliberately narrow. It requires BOTH modules to be silent, so it cannot
     * quiet a student anyone has actually assessed or billed: an attending
     * student with red marks and no finance row is still Priority 1, because
     * the grade is evidence and only the balance is missing.
     *
     * These students do not vanish. `pdo=none` exists precisely to list the
     * ones the board can say nothing about, and the faculty board's "Not graded
     * yet" card counts them - so the gap stays visible as a gap, which is the
     * honest place for it, instead of being dressed up as a retention risk.
     */
    if ($attendance === PDO_ATTENDING && $grade === PDO_GRADE_NO_DATA && $balance === PDO_BALANCE_NO_DATA) {
        return [4, PDO_PRIORITY_OWNERS[4]];
    }
    if ($attendance === PDO_ATTENDING && $balance === PDO_BALANCE_NONE) {
        return [4, PDO_PRIORITY_OWNERS[4]];
    }
    if ($grade === PDO_GRADE_RED) {
        return [1, PDO_PRIORITY_OWNERS[1]];
    }
    if ($grade === PDO_GRADE_YELLOW) {
        return [2, PDO_PRIORITY_OWNERS[2]];
    }
    return [3, PDO_PRIORITY_OWNERS[3]];
}

/**
 * The segment as the sheet writes it, e.g. "Attending | Yellow | 3K to 5K".
 *
 * $settings is optional and only supplies the band names, so a band renamed in
 * Status Management reads its new name here rather than printing its key.
 */
function pdo_segment_label(string $attendance, string $grade, string $balance, array $settings = []): string
{
    return implode(' | ', [
        PDO_ATTENDANCE_LABELS[$attendance] ?? $attendance,
        PDO_GRADE_LABELS[$grade] ?? $grade,
        pdo_balance_label($balance, $settings),
    ]);
}

/**
 * The one deciding factor behind the priority, in plain words.
 *
 * The segment shows all three signals; this names the single rule that actually
 * set the priority, so a caller opening a Priority 1 student reads why it is
 * Priority 1 rather than inferring it from three labels. The branch order is
 * identical to pdo_priority_for() on purpose — the same rule that decides the
 * number decides the sentence, so the two can never say different things.
 */
function pdo_priority_reason(string $attendance, string $grade, string $balance): string
{
    if ($attendance === PDO_ATTENDING && $grade === PDO_GRADE_NO_DATA && $balance === PDO_BALANCE_NO_DATA) {
        return 'Attending, with no grades or finance recorded yet — nothing to flag, and nothing to go on.';
    }
    if ($attendance === PDO_ATTENDING && $balance === PDO_BALANCE_NONE) {
        return $grade === PDO_GRADE_NO_DATA
            ? 'Attending with no balance — not graded yet, and nothing else to flag.'
            : 'Attending with no balance — the safest standing on the board.';
    }
    if ($grade === PDO_GRADE_RED) {
        return 'Failing grades.';
    }
    if ($grade === PDO_GRADE_YELLOW) {
        return 'At-risk grades.';
    }
    /*
     * The last branch now covers two different students, and saying which is
     * the whole point of this sentence: one has passing marks and is here on
     * attendance or money, the other has no marks at all and is here on the
     * same evidence. Reading "Passing grades" on a student nobody has graded
     * would be the reason a reader stops trusting the column.
     */
    if ($grade === PDO_GRADE_NO_DATA) {
        return 'Not graded yet — kept on the list by attendance or an outstanding balance.';
    }
    return 'Passing grades — kept on the list by attendance or an outstanding balance.';
}

/**
 * Everything the list says about one student.
 *
 * Takes the three already-resolved term records rather than querying, so the
 * classification can be tested without a database and so the caller can fetch
 * all three in three queries instead of three per student.
 */
function pdo_classify_student(array $student, ?array $grade, ?array $attendance, ?array $finance, array $settings): array
{
    $gradeColour = pdo_grade_colour($grade, $settings);
    $attendanceStatus = pdo_attendance_status($attendance, $settings);
    $balanceBand = pdo_balance_band($finance, $settings);
    [$priority, $owner] = pdo_priority_for($attendanceStatus, $gradeColour, $balanceBand);

    $conducted = (int)($attendance['total_classes_conducted'] ?? 0);

    return [
        'student_id' => (int)$student['student_id'],
        'student_number' => $student['student_number'] ?? null,
        'student_name' => trim((string)($student['last_name'] ?? '') . ', ' . (string)($student['first_name'] ?? '')),
        'student_type' => $student['student_type'] ?? null,
        'course_code' => $student['course_code'] ?? null,
        'course_name' => $student['course_name'] ?? null,
        'year_level' => isset($student['year_level']) ? (int)$student['year_level'] : null,
        'section' => $student['section'] ?? null,
        'department_id' => isset($student['department_id']) ? (int)$student['department_id'] : null,

        'attendance_status' => $attendanceStatus,
        'attendance_label' => pdo_attendance_label($attendanceStatus, $attendance, $settings),
        'attendance_colour' => pdo_attendance_colour($attendanceStatus, $attendance),
        'present_rate' => $conducted > 0
            ? round(((int)$attendance['present'] / $conducted) * 100, 2)
            : null,

        'grade_colour' => $gradeColour,
        'grade_label' => PDO_GRADE_LABELS[$gradeColour],
        'problem_subjects' => $grade === null ? null :
            (int)($grade['failed'] ?? 0) + (int)($grade['incomplete'] ?? 0)
            + (int)($grade['no_credit'] ?? 0) + (int)($grade['no_grade'] ?? 0),
        'total_subject' => $grade === null ? null : (int)($grade['total_subject'] ?? 0),
        /*
         * Null when there is no attendance row, exactly like total_subject
         * above and balance_amount below. $conducted is already computed for
         * present_rate, but as an int that reads 0 for "no data" -- and the
         * difference between 0 meetings recorded and no record at all is the
         * whole question the data-gap filter asks.
         *
         * faculty_workspace.php read this key on board rows and nothing ever
         * set it, so `=== null` was true for everyone and ?pdo=none ignored
         * attendance entirely: a student with a full attendance record still
         * counted as having no data at all.
         */
        'total_classes_conducted' => $attendance === null ? null : $conducted,
        'grade_period' => $grade === null ? null : ($grade['period'] === null ? null : (int)$grade['period']),

        'balance_band' => $balanceBand,
        'balance_colour' => pdo_balance_colour($balanceBand, $settings),
        'balance_label' => pdo_balance_label($balanceBand, $settings),
        'balance_amount' => $finance === null || $finance['balance_to_data'] === null
            ? null
            : (float)$finance['balance_to_data'],

        'segment' => pdo_segment_label($attendanceStatus, $gradeColour, $balanceBand, $settings),
        'priority' => $priority,
        'owner' => $owner,
        'priority_label' => 'Priority ' . $priority . ': ' . $owner,
        'priority_reason' => pdo_priority_reason($attendanceStatus, $gradeColour, $balanceBand),
    ];
}

/**
 * The three signals the matrix classifies on, for a batch of students.
 *
 * Three queries for the whole batch rather than three per student: the contact
 * queue calls this for every student in the workspace at once, and a per-student
 * fetch would be several hundred round trips to render one page.
 *
 * Returns ['grades' => [student_id => row], 'attendance' => ..., 'finance' => ...]
 * with a student absent from a map when they have no record - which is a
 * meaningful state the classifier reads, not a gap to be filled with zeroes.
 */
function pdo_load_signals(PDO $pdo, array $studentIds, ?int $semesterId = null, ?int $schoolYearId = null, $period = null): array
{
    $ids = array_values(array_unique(array_map('intval', array_filter($studentIds, 'is_numeric'))));
    if (empty($ids)) {
        return ['grades' => [], 'attendance' => [], 'finance' => []];
    }
    $idList = implode(',', $ids);

    /*
     * The periodical, when one is asked for.
     *
     * Without it each signal answers for the WHOLE term -- the latest
     * periodical's grades, every periodical's attendance added up, the most
     * recent balance. That is the right reading of "how is this student doing
     * this semester", and the wrong one for "how is this student doing in P1",
     * which is what a screen showing P1 is claiming to answer.
     *
     * Same convention the rest of the system already follows: an explicit
     * period means that periodical's own row and nothing else. See the header
     * of lib/term_records.php, which spells out why the three modules roll up
     * differently when no period is named and identically when one is.
     */
    [$gradePeriodSql, $periodParams] = api_period_filter_sql('g.period', $period);
    [$attPeriodSql] = api_period_filter_sql('a.period', $period);
    [$finPeriodSql] = api_period_filter_sql('f.period', $period);

    $bind = static function (PDOStatement $stmt) use ($semesterId, $schoolYearId, $periodParams): void {
        if ($semesterId !== null) { $stmt->bindValue(':semester_id', $semesterId, PDO::PARAM_INT); }
        if ($schoolYearId !== null) { $stmt->bindValue(':school_year_id', $schoolYearId, PDO::PARAM_INT); }
        foreach ($periodParams as $name => $value) { $stmt->bindValue($name, $value, PDO::PARAM_INT); }
    };

    /*
     * One grade row per student: the latest periodical if they have any, else
     * the whole-term row. Same precedence as the semester rollup in grades.php -
     * a term row sitting alongside periodicals is the older import, so letting it
     * win would classify students on stale marks.
     */
    $gradeStmt = $pdo->prepare(
        "SELECT student_id, total_subject, passed, failed, incomplete, no_credit, no_grade, period,
                school_year_id, semester_id
           FROM (
               SELECT g.student_id, g.total_subject, g.passed, g.failed, g.incomplete,
                      g.no_credit, g.no_grade, g.period,
                      g.school_year_id, g.semester_id,
                      ROW_NUMBER() OVER (
                          PARTITION BY g.student_id
                          ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC
                      ) AS pick
                 FROM grades g
                WHERE g.student_id IN ($idList) AND g.archived_at IS NULL"
        . ($semesterId !== null ? ' AND g.semester_id = :semester_id' : '')
        . ($schoolYearId !== null ? ' AND g.school_year_id = :school_year_id' : '')
        . ($gradePeriodSql !== '' ? ' AND ' . $gradePeriodSql : '') .
           ") latest
          WHERE pick = 1"
    );
    $bind($gradeStmt);
    $gradeStmt->execute();

    /*
     * Attendance summed across the term, which is how attendance-summary.php
     * reports it: classes accumulate, so P1 + P2 + P3 genuinely is the semester.
     */
    $attStmt = $pdo->prepare(
        "SELECT a.student_id,
                COALESCE(SUM(a.total_classes_conducted), 0) AS total_classes_conducted,
                COALESCE(SUM(a.present), 0) AS present,
                COALESCE(SUM(a.absent), 0) AS absent
           FROM attendance a
          WHERE a.student_id IN ($idList)"
        . ($semesterId !== null ? ' AND a.semester_id = :semester_id' : '')
        . ($schoolYearId !== null ? ' AND a.schoolyear_id = :school_year_id' : '')
        . ($attPeriodSql !== '' ? ' AND ' . $attPeriodSql : '') .
        " GROUP BY a.student_id"
    );
    $bind($attStmt);
    $attStmt->execute();

    /*
     * One balance per student: the latest reading, by date then by periodical.
     * A balance is a running figure, so the most recent one is what is owed -
     * matching how finance-summary.php picks a current balance.
     */
    $finStmt = $pdo->prepare(
        "SELECT student_id, balance_to_data, `date`, period, school_year_id, semester_id
           FROM (
               SELECT f.student_id, f.balance_to_data, f.`date`, f.period,
                      f.school_year_id, f.semester_id,
                      ROW_NUMBER() OVER (
                          PARTITION BY f.student_id
                          ORDER BY f.`date` DESC, (f.period IS NULL) ASC, f.period DESC, f.finance_id DESC
                      ) AS pick
                 FROM finance f
                WHERE f.student_id IN ($idList)"
        . ($semesterId !== null ? ' AND f.semester_id = :semester_id' : '')
        . ($schoolYearId !== null ? ' AND f.school_year_id = :school_year_id' : '')
        . ($finPeriodSql !== '' ? ' AND ' . $finPeriodSql : '') .
             ") latest
          WHERE pick = 1"
    );
    $bind($finStmt);
    $finStmt->execute();

    $byStudent = static function (PDOStatement $stmt): array {
        $map = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $map[(int)$row['student_id']] = $row;
        }
        return $map;
    };

    return [
        'grades' => $byStudent($gradeStmt),
        'attendance' => $byStudent($attStmt),
        'finance' => $byStudent($finStmt),
    ];
}

/**
 * The most recent contact attempt on each of these students, for one term.
 *
 * The board classifies from grades, attendance and balance, and none of those
 * move because somebody rang the student -- so without this a caller records a
 * conversation and the row sits exactly where it was, indistinguishable from a
 * student nobody has touched. That is how a call list gets worked twice.
 *
 * SCOPED TO THE TERM ON SCREEN, not to all history. A conversation in last
 * semester's P3 says nothing about whether this periodical's list has been
 * worked, and letting it clear a row would hide a student on the strength of a
 * call made months ago. When a period is named the match is exact; when the
 * board is showing the whole term, any periodical within it counts, because
 * that is the span the reader is asking about.
 *
 * One query for the batch, in the shape pdo_load_signals() above uses. The
 * correlated MAX picks the latest attempt per student: a student rung three
 * times has three rows, and the stale ones must not decide what the board says
 * about them.
 */
function pdo_load_last_contact(PDO $pdo, array $studentIds, ?int $semesterId = null, ?int $schoolYearId = null, $period = null): array
{
    $ids = array_values(array_unique(array_map('intval', array_filter($studentIds, 'is_numeric'))));
    if (empty($ids)) {
        return [];
    }
    $idList = implode(',', $ids);

    $where = ["a.student_id IN ($idList)"];
    $params = [];
    if ($semesterId !== null) {
        $where[] = 'a.semester_id = :semester_id';
        $params[':semester_id'] = $semesterId;
    }
    if ($schoolYearId !== null) {
        $where[] = 'a.school_year_id = :school_year_id';
        $params[':school_year_id'] = $schoolYearId;
    }
    // api_normalize_period returns null for "the whole term", which is the case
    // where any periodical's contact counts and so adds no clause at all.
    $normalizedPeriod = function_exists('api_normalize_period') ? api_normalize_period($period) : null;
    if ($normalizedPeriod !== null && $normalizedPeriod !== false) {
        $where[] = 'a.period = :period';
        $params[':period'] = $normalizedPeriod;
    }
    $whereSql = implode(' AND ', $where);

    /*
     * The term filter is written ONCE, inside the grouped subquery, and the
     * outer query joins to the id it picked. Testing `attempt_id = (SELECT
     * MAX(...) WHERE <same filter>)` would state it twice, which means two
     * copies to keep in step and the same named placeholder appearing twice in
     * one statement -- something PDO rejects without emulated prepares.
     */
    $sql = "SELECT a.student_id,
                   a.contacted_at,
                   a.intervention_status AS outcome,
                   a.contact_method,
                   a.period,
                   TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS by_name,
                   COALESCE(actor_role.role_name, user_role.role_name) AS by_role_name
              FROM student_contact_attempt a
              JOIN (
                    SELECT student_id, MAX(attempt_id) AS attempt_id
                      FROM student_contact_attempt a
                     WHERE {$whereSql}
                     GROUP BY student_id
              ) latest ON latest.attempt_id = a.attempt_id
              LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
              /* Prefer the role stamped on the attempt. The user's current
                 role is only a fallback for older rows created before that
                 audit field was populated. */
              LEFT JOIN role actor_role ON actor_role.role_id = a.attempted_by_role_id
              LEFT JOIN role user_role ON user_role.role_id = u.role";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $map[(int)$row['student_id']] = $row;
    }
    return $map;
}

/**
 * The PDO filter values the three record modules accept, and what each means.
 *
 * Grades, Attendance and Finance each show a list of students, and the question
 * "which of these are we worried about" is the same question on all three. It
 * is answered here rather than three times, for the reason this whole file
 * exists: the priority rules are five branches that took a 48-row sheet to
 * derive, and a screen that re-derived them would be a screen that quietly
 * disagrees with the PDO list about the same student.
 *
 * `flagged` is the one worth explaining. Every student gets a priority, so
 * "on the PDO list" is not a distinction — priority 4 is
 * Attending | Green | No Balance, the safest standing on the board, and 1 to 3
 * are the ones with something wrong. `flagged` is those three, which is what
 * somebody means when they ask to see the potential drop-outs.
 */
function pdo_filter_options(): array
{
    return [
        'flagged' => 'Potential drop out (P1-P3)',
        '1' => 'Priority 1 - College',
        '2' => 'Priority 2 - Coaches',
        '3' => 'Priority 3 - Coaches',
        '4' => 'Priority 4 - No concern',
        /*
         * Not a priority - the absence of one.
         *
         * Every student is classified, so nobody is "missing" from the board;
         * a student with no grades, no attendance and no finance row for the
         * term still lands somewhere, on the strength of three defaults. That
         * makes them indistinguishable from a student genuinely doing fine,
         * which is the more dangerous of the two to leave unmarked. This picks
         * out the ones the board cannot actually say anything about, so the gap
         * can be filled rather than read as good news.
         */
        'none' => 'No PDO record yet',
    ];
}

/** True when `$value` is a filter this library will act on. */
function pdo_filter_is_valid($value): bool
{
    return is_string($value) && $value !== '' && array_key_exists($value, pdo_filter_options());
}

/**
 * The student ids matching a PDO filter, or null for "do not filter".
 *
 * NULL AND AN EMPTY ARRAY MEAN DIFFERENT THINGS, and conflating them is the bug
 * this signature exists to prevent: null is "no filter was asked for, show
 * everything", while [] is "the filter was asked for and nothing matched, show
 * nothing". A caller that treats [] as null turns an empty result into the
 * full unfiltered list — the filter appears to do nothing, which reads as a
 * broken control rather than as an honest empty answer.
 *
 * The term arguments scope the signals, so "flagged" on a page filtered to P2 of
 * 1st Semester means flagged BY that periodical's records rather than by
 * whatever the student's most recent term happens to say. The period is passed
 * through from the page's own periodical filter for exactly that reason: a
 * table showing P1 rows under a "potential drop out" filter judged on P3 marks
 * would be two different questions answered in one view.
 *
 * Every non-archived student is classified, not just the page being shown: the
 * priority is a fact about a student, and which page they land on is decided
 * afterwards by intersecting these ids with the list query's own WHERE. That
 * also keeps the caller's own scoping authoritative — this narrows a result,
 * it can never widen one.
 */
function pdo_filter_student_ids(PDO $pdo, $filter, ?int $semesterId = null, ?int $schoolYearId = null, $period = null): ?array
{
    if (!pdo_filter_is_valid($filter)) {
        return null;
    }

    $students = $pdo->query(
        'SELECT student_id FROM student WHERE archived_at IS NULL'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    if (empty($students)) {
        return [];
    }

    $settings = pdo_settings($pdo);
    $signals = pdo_load_signals($pdo, array_column($students, 'student_id'), $semesterId, $schoolYearId, $period);

    $matched = [];

    /*
     * "No record" is answered from the signals themselves rather than from a
     * priority, because there is no priority that means this. A student counts
     * as having a record if ANY of the three modules holds a row for the term:
     * one grade sheet is enough for the board to have something to say.
     */
    if ($filter === 'none') {
        foreach ($students as $student) {
            $id = (int)$student['student_id'];
            $hasAnyRecord = isset($signals['grades'][$id])
                || isset($signals['attendance'][$id])
                || isset($signals['finance'][$id]);
            if (!$hasAnyRecord) {
                $matched[] = $id;
            }
        }

        return $matched;
    }

    $wanted = $filter === 'flagged' ? PDO_FLAGGED_PRIORITIES : [(int)$filter];

    foreach ($students as $student) {
        $id = (int)$student['student_id'];
        // pdo_priority_for() takes the three resolved signals and nothing else,
        // so the student row here needs no columns beyond the id.
        $priority = pdo_priority_for(
            pdo_attendance_status($signals['attendance'][$id] ?? null, $settings),
            pdo_grade_colour($signals['grades'][$id] ?? null, $settings),
            pdo_balance_band($signals['finance'][$id] ?? null, $settings)
        )[0];

        if (in_array($priority, $wanted, true)) {
            $matched[] = $id;
        }
    }

    return $matched;
}

/**
 * Folds a PDO filter into a list query's WHERE parts.
 *
 * The ids go in as a literal list rather than as bound parameters. They are
 * every one of them an int cast a line earlier and never touch user input, and
 * the alternative is several hundred placeholders on a query that already
 * carries a dozen — MariaDB's placeholder limit is reachable that way.
 *
 * The no-match case emits `0 = 1` rather than being skipped. See the note on
 * pdo_filter_student_ids() about why an empty answer must not become every row.
 */
function pdo_filter_apply(array &$where, PDO $pdo, $filter, ?int $semesterId, ?int $schoolYearId, string $column, $period = null): bool
{
    $ids = pdo_filter_student_ids($pdo, $filter, $semesterId, $schoolYearId, $period);
    if ($ids === null) {
        return false;
    }
    $where[] = empty($ids)
        ? '0 = 1'
        : $column . ' IN (' . implode(',', array_map('intval', $ids)) . ')';
    return true;
}
