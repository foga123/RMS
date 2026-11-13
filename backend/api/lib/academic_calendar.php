<?php
/**
 * What term it is right now, and the two ways of deciding.
 *
 * Every import in this system -- grades, attendance, finance -- asks for a
 * school year, a semester and a periodical before it will read a file, and
 * until now it asked with three empty dropdowns. This is the one place that
 * answers, so the three modules cannot answer differently. See
 * 2026_09_01_academic_calendar.sql for the shape of the two tables and why the
 * manual pin stores a term rather than pointing at a dated row.
 *
 * Imports use the active academic year. Semester and periodical remain
 * selectable; the calendar fills those choices only when nothing was supplied.
 */

if (!defined('ACADEMIC_CALENDAR_LOADED')) {
    define('ACADEMIC_CALENDAR_LOADED', true);

// api_normalize_period(), used by academic_calendar_import_term(). Required
// here rather than relied on from the caller: the import endpoints happen to
// include periodic_lib first, so the dependency was satisfied by load order
// alone and any other caller got a fatal on an undefined function.
require_once __DIR__ . '/../periodic_lib.php';

/**
 * The settings row keys, and what a missing table falls back to.
 *
 * define() rather than const because this block is inside the include guard,
 * and PHP only allows `const` at the top level of a file or a class.
 */
define('ACADEMIC_CALENDAR_DEFAULTS', [
    'mode' => 'auto',
    'manual_school_year_id' => '',
    'manual_semester_id' => '',
    'manual_period' => '',
]);

/**
 * The pin and the switch, as a plain array.
 *
 * Reads defensively: an installation that has the code but not the migration
 * gets the defaults rather than a 500 on every page that touches an import.
 * The calendar is a convenience -- it must not be able to take the portal down.
 */
function academic_calendar_settings(PDO $pdo): array {
    $settings = ACADEMIC_CALENDAR_DEFAULTS;
    if (api_table_exists($pdo, 'academic_calendar_setting')) {
        $rows = $pdo->query('SELECT setting_key, setting_value FROM academic_calendar_setting')
                    ->fetchAll(PDO::FETCH_KEY_PAIR);
        foreach (array_keys($settings) as $key) {
            if (array_key_exists($key, $rows)) {
                $settings[$key] = (string)$rows[$key];
            }
        }
    }
    if ($settings['mode'] !== 'manual') {
        $settings['mode'] = 'auto';
    }
    return $settings;
}

/** A settings value as a positive int, or null for "not pinned". */
function academic_calendar_pin_int($value): ?int {
    $trimmed = trim((string)$value);
    if ($trimmed === '' || !ctype_digit($trimmed)) {
        return null;
    }
    $number = (int)$trimmed;
    return $number > 0 ? $number : null;
}

/** How a periodical reads. Mirrors periods.js and periodic_lib.php. */
function academic_calendar_period_label(?int $period): string {
    return $period === null ? 'Whole Periodical' : 'P' . $period;
}

/**
 * Every dated window, newest first, with the year and semester spelled out.
 *
 * Ordered by start date descending because the panel that renders this is a
 * maintenance screen: the rows somebody is about to edit are the current ones
 * and the ones just ahead, not 2022's.
 */
function academic_calendar_terms(PDO $pdo): array {
    $sql = 'SELECT t.term_id, t.school_year_id, t.semester_id, t.period,
                   t.starts_on, t.ends_on,
                   sy.schoolyear_name, s.semester_name
              FROM academic_term t
              JOIN school_year sy ON sy.school_year_id = t.school_year_id
              JOIN semester s ON s.semester_id = t.semester_id
             ORDER BY t.starts_on DESC, t.period DESC';
    if (!api_table_exists($pdo, 'academic_term')) {
        return [];
    }
    $rows = $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $today = date('Y-m-d');
    foreach ($rows as $index => $row) {
        $rows[$index]['term_id'] = (int)$row['term_id'];
        $rows[$index]['school_year_id'] = (int)$row['school_year_id'];
        $rows[$index]['semester_id'] = (int)$row['semester_id'];
        $rows[$index]['period'] = (int)$row['period'];
        $rows[$index]['period_label'] = academic_calendar_period_label((int)$row['period']);
        $rows[$index]['is_today'] = $row['starts_on'] <= $today && $today <= $row['ends_on'];
    }
    return $rows;
}

/**
 * The answer, plus enough of the reasoning to put on screen.
 *
 * `source` is the load-bearing field. A default nobody can explain is a default
 * nobody trusts, so the panel and the import dialogs both say which of these
 * happened rather than just showing three filled-in dropdowns:
 *
 *   manual        somebody pinned it. The dates, if any, are being ignored.
 *   in_term       today falls inside a window. The ordinary case.
 *   after_term    today is past the last window that ended -- a semester break,
 *                 or a calendar nobody has extended yet.
 *   before_term   the calendar starts in the future. First run of a new year.
 *   current_year  no dated windows at all; only school_year.is_current is known,
 *                 so the year is filled in and the rest left blank. This is
 *                 exactly how the dialogs behaved before the calendar existed.
 *   none          nothing is set anywhere. Blank dropdowns, as before.
 *
 * WHY after_term PICKS THE PERIOD THAT JUST ENDED
 *
 * Encoding lags the calendar. P1 grades are uploaded after P1 finishes, not
 * during it, so on the first day of a semester break the term somebody is most
 * likely importing for is the one that just closed -- not the one starting in
 * three weeks. Guessing forward would file a P3 sheet under next semester's P1.
 */
function academic_calendar_current(PDO $pdo): array {
    $settings = academic_calendar_settings($pdo);

    if ($settings['mode'] === 'manual') {
        $pinned = academic_calendar_manual_term($pdo, $settings);
        // A half-set pin -- mode flipped to manual but no year chosen -- falls
        // through to the dates rather than resolving to nothing. Turning the
        // switch on should never be able to leave the portal with no answer.
        if ($pinned !== null) {
            return $pinned;
        }
    }

    $dated = academic_calendar_dated_term($pdo);
    if ($dated !== null) {
        return $dated;
    }

    return academic_calendar_current_year_only($pdo);
}

/** The pinned term with its names filled in, or null if the pin is unusable. */
function academic_calendar_manual_term(PDO $pdo, array $settings): ?array {
    // Semester/period may be pinned; the academic year follows dated windows.
    $active = academic_calendar_dated_term($pdo) ?? academic_calendar_current_year_only($pdo);
    $yearId = $active['school_year_id'];
    if ($yearId === null) {
        return null;
    }
    $semesterId = academic_calendar_pin_int($settings['manual_semester_id']);
    $period = academic_calendar_pin_int($settings['manual_period']);
    if ($period !== null && ($period < 1 || $period > 3)) {
        $period = null;
    }

    $year = $pdo->prepare('SELECT schoolyear_name FROM school_year WHERE school_year_id = :id LIMIT 1');
    $year->execute([':id' => $yearId]);
    $yearName = $year->fetchColumn();
    // The pinned year was deleted. Better to fall back to the dates than to
    // hand every import dialog an id that resolves to nothing.
    if ($yearName === false) {
        return null;
    }

    $semesterName = null;
    if ($semesterId !== null) {
        $semester = $pdo->prepare('SELECT semester_name FROM semester WHERE semester_id = :id LIMIT 1');
        $semester->execute([':id' => $semesterId]);
        $found = $semester->fetchColumn();
        if ($found === false) {
            $semesterId = null;
        } else {
            $semesterName = $found;
        }
    }

    return academic_calendar_shape('manual', [
        'school_year_id' => $yearId,
        'schoolyear_name' => $yearName,
        'semester_id' => $semesterId,
        'semester_name' => $semesterName,
        'period' => $period,
    ]);
}

/** The window containing today, else the one that ended last, else the next. */
function academic_calendar_dated_term(PDO $pdo): ?array {
    $select = 'SELECT t.school_year_id, t.semester_id, t.period, t.starts_on, t.ends_on,
                      sy.schoolyear_name, s.semester_name
                 FROM academic_term t
                 JOIN school_year sy ON sy.school_year_id = t.school_year_id
                 JOIN semester s ON s.semester_id = t.semester_id ';

    // No table means no dates; the caller falls back to the current year.
    if (!api_table_exists($pdo, 'academic_term')) {
        return null;
    }

    $today = date('Y-m-d');

    // Windows are not allowed to overlap -- the endpoint refuses one on save --
    // so this ordering only decides between rows that should not both exist.
    // Most recently begun wins, which is how a term replaces the one before it.
    $inTerm = academic_calendar_one($pdo, $select,
        ':today BETWEEN t.starts_on AND t.ends_on', 't.starts_on DESC, t.ends_on ASC', $today);
    if ($inTerm) {
        return academic_calendar_from_row('in_term', $inTerm);
    }

    /*
     * Today falls in a gap. The nearer boundary wins.
     *
     * The first version of this simply preferred the periodical that had just
     * ended, on the reasoning that encoding lags the calendar -- P1 grades are
     * uploaded after P1 closes. That reasoning is right for a semester break and
     * badly wrong across a summer: once ANY term has ended, "the last one to
     * end" always matches, so on 5 August 2027, with a new P1 starting on the
     * 10th, imports would still have defaulted to a P3 that finished the
     * previous December. It also made the upcoming-term case unreachable after
     * the very first year -- a branch that could only ever fire on a brand new
     * installation.
     *
     * Comparing the two distances keeps the behaviour that was wanted and drops
     * the one that was not: a week after P1 ends, with P2 three weeks out, P1 is
     * nearer and still wins; eight months after last year, with P1 five days
     * out, the new term wins. A tie goes to the term that ended, because that is
     * the one with encoding still outstanding.
     */
    $ended = academic_calendar_one($pdo, $select, 't.ends_on < :today', 't.ends_on DESC, t.period DESC', $today);
    $upcoming = academic_calendar_one($pdo, $select, 't.starts_on > :today', 't.starts_on ASC, t.period ASC', $today);

    if ($ended && $upcoming) {
        $daysSinceEnd = academic_calendar_days_between($ended['ends_on'], $today);
        $daysUntilStart = academic_calendar_days_between($today, $upcoming['starts_on']);
        return $daysSinceEnd <= $daysUntilStart
            ? academic_calendar_from_row('after_term', $ended)
            : academic_calendar_from_row('before_term', $upcoming);
    }
    if ($ended) {
        return academic_calendar_from_row('after_term', $ended);
    }
    if ($upcoming) {
        return academic_calendar_from_row('before_term', $upcoming);
    }
    return null;
}

/** One row matching `$where`, or null. */
function academic_calendar_one(PDO $pdo, string $select, string $where, string $order, string $today): ?array {
    $stmt = $pdo->prepare($select . 'WHERE ' . $where . ' ORDER BY ' . $order . ' LIMIT 1');
    $stmt->execute([':today' => $today]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

/** Whole days from `$from` to `$to`, both 'Y-m-d'. Negative if `$to` is earlier. */
function academic_calendar_days_between(string $from, string $to): int {
    $start = new DateTimeImmutable($from . ' 00:00:00');
    $end = new DateTimeImmutable($to . ' 00:00:00');
    return (int)$start->diff($end)->format('%r%a');
}

/** A fetched `academic_term` row in the shape every caller reads. */
function academic_calendar_from_row(string $source, array $row): array {
    return academic_calendar_shape($source, [
        'school_year_id' => (int)$row['school_year_id'],
        'schoolyear_name' => $row['schoolyear_name'],
        'semester_id' => (int)$row['semester_id'],
        'semester_name' => $row['semester_name'],
        'period' => (int)$row['period'],
        'starts_on' => $row['starts_on'],
        'ends_on' => $row['ends_on'],
    ]);
}

/** school_year.is_current and nothing else -- the pre-calendar behaviour. */
function academic_calendar_current_year_only(PDO $pdo): array {
    $row = api_column_exists($pdo, 'school_year', 'is_current')
        ? $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year WHERE is_current = 1 LIMIT 1')
              ->fetch(PDO::FETCH_ASSOC)
        : false;
    if (!$row) {
        return academic_calendar_shape('none', []);
    }
    return academic_calendar_shape('current_year', [
        'school_year_id' => (int)$row['school_year_id'],
        'schoolyear_name' => $row['schoolyear_name'],
    ]);
}

/**
 * One shape for all five outcomes, so a caller never has to check which
 * happened before reading a field.
 *
 * Every key is always present. A resolver that returns three keys on one path
 * and six on another is a resolver whose callers all learn to write `?? null`
 * and then stop noticing which fields are real.
 */
function academic_calendar_shape(string $source, array $parts): array {
    $shape = array_merge([
        'source' => $source,
        'school_year_id' => null,
        'schoolyear_name' => null,
        'semester_id' => null,
        'semester_name' => null,
        'period' => null,
        'starts_on' => null,
        'ends_on' => null,
    ], $parts);

    $shape['period_label'] = academic_calendar_period_label($shape['period']);
    $shape['label'] = academic_calendar_label($shape);
    $shape['note'] = academic_calendar_note($shape);
    return $shape;
}

/** "P1 - 1st Semester, 2026-2027", skipping whatever is not known. */
function academic_calendar_label(array $shape): string {
    $parts = array_filter([
        $shape['period'] !== null ? academic_calendar_period_label($shape['period']) : null,
        $shape['semester_name'],
        $shape['schoolyear_name'],
    ]);
    return $parts ? implode(' - ', $parts) : 'Not set';
}

/** The sentence shown under the defaults, saying why they are what they are. */
function academic_calendar_note(array $shape): string {
    $when = static function (?string $date): string {
        if (!$date) return '';
        $stamp = strtotime($date);
        return $stamp ? date('j M Y', $stamp) : $date;
    };

    switch ($shape['source']) {
        case 'manual':
            return 'Pinned by an administrator. Imports default here until the pin is cleared.';
        case 'in_term':
            return 'Running from ' . $when($shape['starts_on']) . ' to ' . $when($shape['ends_on']) . '.';
        case 'after_term':
            return 'This periodical ended on ' . $when($shape['ends_on'])
                 . '. Nothing is scheduled for today, so imports still default here.';
        case 'before_term':
            return 'The calendar starts on ' . $when($shape['starts_on']) . '. Imports default to the first term ahead.';
        case 'current_year':
            return 'No term dates have been entered, so only the current school year is filled in.';
        default:
            return 'No current school year and no term dates. Imports open blank.';
    }
}

/**
 * The term an import should be filed under: what the uploader chose, else what
 * the calendar says.
 *
 * Every import endpoint used to refuse an upload that named no semester and no
 * school year, which put the whole burden on the client. That was fine while
 * three screens filled the pickers in and wrong everywhere else: Students and
 * Enrollment Status defaulted their year from the wall clock instead, so an
 * office that had pinned the calendar - pinned it precisely because the dates
 * were not to be trusted - still got the clock's answer. And any other caller
 * (a script, a re-run, a future screen) had to know the ids up front or get a
 * 400 telling it to pick something it had no way to look up.
 *
 * So the posted value still wins wherever one was sent. Only a blank falls
 * through to the calendar. The three parts resolve independently, because a
 * calendar that knows the year but not the periodical should still fill the
 * year in rather than answering nothing.
 *
 * Returns [school_year_id, semester_id, period, source] where source is
 * 'request' when nothing was defaulted, 'calendar' when anything was, and
 * 'none' when neither had an answer - the caller reports that as the same 400
 * it always did, because at that point there genuinely is nothing to file the rows under.
 *
 * @param array $post   The request body, usually $_POST.
 * @return array{0:?int,1:?int,2:mixed,3:string}
 */
function academic_calendar_import_term(PDO $pdo, array $post): array {
    $intOf = static function ($value): ?int {
        if ($value === null) { return null; }
        $text = trim((string)$value);
        if ($text === '' || !is_numeric($text)) { return null; }
        $number = (int)$text;
        return $number > 0 ? $number : null;
    };

    $schoolYearId = $intOf($post['school_year_id'] ?? null) ?? $intOf($post['schoolyear_id'] ?? null);
    $semesterId   = $intOf($post['semester_id'] ?? null);

    /*
     * A period is three-valued and blank is a real answer, so it cannot be
     * defaulted on emptiness the way the ids are. An absent key means "not
     * said" and takes the calendar's periodical; a key present but blank means
     * "the whole semester", which is a choice and is left alone.
     */
    $periodGiven = array_key_exists('period', $post);
    $period = $periodGiven ? api_normalize_period($post['period']) : null;

    $needsYear     = $schoolYearId === null;
    $needsSemester = $semesterId === null;
    $needsPeriod   = !$periodGiven;

    if (!$needsYear && !$needsSemester && !$needsPeriod) {
        return [$schoolYearId, $semesterId, $period, 'request'];
    }

    $current = academic_calendar_current($pdo);
    $used = false;

    if ($needsYear && $current['school_year_id'] !== null) {
        $schoolYearId = (int)$current['school_year_id'];
        $used = true;
    }
    if ($needsSemester && $current['semester_id'] !== null) {
        $semesterId = (int)$current['semester_id'];
        $used = true;
    }
    if ($needsPeriod && $current['period'] !== null) {
        $period = (int)$current['period'];
        $used = true;
    }

    return [$schoolYearId, $semesterId, $period, $used ? 'calendar' : 'none'];
}

/**
 * The term an import writes into: resolved, validated, and ready to file rows
 * under — or the reason it could not be.
 *
 * academic_calendar_import_term() above answers "which term", and this answers
 * "and is it usable". They are separate because the first is a decision and the
 * second is four checks against the database, and only the second needs to be
 * able to refuse.
 *
 * Returns:
 *   ['term' => ['school_year_id' => int, 'semester_id' => int,
 *               'period' => ?int, 'source' => string], 'error' => null]
 * or
 *   ['term' => null, 'error' => 'a sentence for the uploader']
 *
 * The message is RETURNED rather than emitted. Each import endpoint has its own
 * JSON responder — gradeimport_out(), attimport_out(), financeimport_out() —
 * and a library that called one of them would have to know which caller it was
 * inside. Handing the sentence back keeps this file free of every endpoint's
 * response shape, and lets a future caller answer differently (a queue worker
 * logging rather than replying, say).
 *
 * This is what the three import endpoints each used to carry as their own copy
 * of the same twenty lines, differing only in which out() they called.
 */
function academic_calendar_resolve_import_term(PDO $pdo, array $post, bool $calendarYearOnly = false): array {
    $fail = static function (string $message): array {
        return ['term' => null, 'error' => $message];
    };

    if ($calendarYearOnly) {
        $currentYear = academic_calendar_current($pdo)['school_year_id'];
        foreach (['school_year_id', 'schoolyear_id'] as $key) {
            if (!array_key_exists($key, $post)) continue;
            $given = academic_calendar_pin_int($post[$key]);
            if ($given !== null && $given !== $currentYear) return $fail('Imports must use the current Academic Calendar school year. Refresh the import dialog after changing the calendar.');
        }
        $post['school_year_id'] = $currentYear;
        unset($post['schoolyear_id']);
    }
    [$schoolYearId, $semesterId, $period, $source] = academic_calendar_import_term($pdo, $post);

    if ($semesterId === null || $schoolYearId === null) {
        return $fail(
            'Select a semester and school year for this import. '
            . 'The academic calendar has no current term to fall back on.'
        );
    }

    /*
     * A period is validated before the ids are looked up, because it is the one
     * that can be malformed rather than merely absent — api_normalize_period()
     * returns false for "banana" and null for blank, and those are different
     * answers that must not collapse into one message.
     */
    if ($period === false) {
        return $fail(
            'Period must be P1, P2 or P3, or left blank to upload the sheet as the semester total.'
        );
    }

    $semesterCheck = $pdo->prepare('SELECT semester_id FROM semester WHERE semester_id = :id');
    $semesterCheck->execute([':id' => $semesterId]);
    if (!$semesterCheck->fetchColumn()) {
        return $fail('The selected semester does not exist.');
    }

    $yearCheck = $pdo->prepare('SELECT school_year_id FROM school_year WHERE school_year_id = :id');
    $yearCheck->execute([':id' => $schoolYearId]);
    if (!$yearCheck->fetchColumn()) {
        return $fail('The selected school year does not exist.');
    }

    return [
        'term' => [
            'school_year_id' => (int)$schoolYearId,
            'semester_id'    => (int)$semesterId,
            'period'         => $period === null ? null : (int)$period,
            'source'         => $source,
        ],
        'error' => null,
    ];
}

}
