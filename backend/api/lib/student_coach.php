<?php
/**
 * A student's coach, and the coaching unit that coach belongs to.
 *
 * The coach is the WORKER on the student's follow-up team - an SSP Caller for a
 * Non-STAR student, a KASAMA for a STAR one - and it is stored as that
 * worker's row in `ssp_assignment`. Deliberately not in `student.coaching_unit`
 * or the `coaching_unit` table, although the original schema drew it there: the
 * contact workspace decides which students a coach can open from
 * ssp_assignment, so a coach written anywhere else would show on the student
 * and never reach the coach's own queue. One place, read by everything.
 *
 * The coaching unit follows from the cohort: SSP coaches Non-STAR students,
 * KASAMA coaches STAR ones. That is API_FOLLOW_UP_TEAMS in middleware/auth.php,
 * read here rather than restated.
 *
 * Used by ssp_assignment.php (the board's Assign / Reassign and the coach
 * import) and student.php (the Coach and Coaching Unit columns).
 */

/** The unit each coach role belongs to, keyed by the team's worker role id. */
const STUDENT_COACHING_UNIT_BY_ROLE = [
    6 => 'SSP',     // SSP Caller
    12 => 'KASAMA', // KASAMA
];

/** Role ids that count as a coach: the first member of every follow-up team. */
function student_coach_role_ids(): array
{
    $ids = [];
    foreach (API_FOLLOW_UP_TEAMS as $roleIds) {
        $ids[(int)$roleIds[0]] = true;
    }
    return array_keys($ids);
}

/** The coach role for a student type, or null when the type has no team. */
function student_coach_role_for_type(?string $studentType): ?int
{
    $team = api_follow_up_team_role_ids($studentType);
    return $team ? (int)$team[0] : null;
}

/** "SSP" or "KASAMA" for a student type, or null when it has no team. */
function student_coaching_unit(?string $studentType): ?string
{
    $roleId = student_coach_role_for_type($studentType);
    return $roleId !== null ? (STUDENT_COACHING_UNIT_BY_ROLE[$roleId] ?? null) : null;
}

/**
 * Each student's coach, for a batch of students.
 *
 * One coach per student is the rule every write keeps, and
 * migrations/2026_10_01_ssp_assignment_one_coach.sql makes the table refuse a
 * second row. On a database that has not had that migration a student can
 * still carry two; the earliest is reported and `coach_count` says there are
 * more.
 *
 * @return array<int,array> student_id => [user_id, name, email, role_id, coach_count]
 */
function student_coaches_by_student(PDO $pdo, array $studentIds): array
{
    $studentIds = array_values(array_unique(array_filter(array_map('intval', $studentIds))));
    if (!$studentIds) {
        return [];
    }

    $roleIds = student_coach_role_ids();
    $studentPlaceholders = implode(',', array_fill(0, count($studentIds), '?'));
    $rolePlaceholders = implode(',', array_fill(0, count($roleIds), '?'));

    $stmt = $pdo->prepare(
        "SELECT sa.student_id, u.user_id, u.first_name, u.last_name, u.email, u.role AS role_id
           FROM ssp_assignment sa
           JOIN user u ON u.user_id = sa.caller_user_id
          WHERE sa.student_id IN ($studentPlaceholders)
            AND u.role IN ($rolePlaceholders)
       ORDER BY sa.student_id ASC, sa.assignment_id ASC"
    );
    $stmt->execute(array_merge($studentIds, $roleIds));

    $coaches = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentId = (int)$row['student_id'];
        if (isset($coaches[$studentId])) {
            $coaches[$studentId]['coach_count'] += 1;
            continue;
        }
        $name = trim(((string)$row['first_name']) . ' ' . ((string)$row['last_name']));
        $coaches[$studentId] = [
            'user_id' => (int)$row['user_id'],
            'name' => $name !== '' ? $name : (string)($row['email'] ?? ''),
            'email' => $row['email'] ?? '',
            'role_id' => (int)$row['role_id'],
            'coach_count' => 1,
        ];
    }

    return $coaches;
}

/**
 * Make this person the student's coach, replacing whoever held it.
 *
 * Reassign rather than add: a student has one assignee, their coach, so
 * choosing a new one takes the old one off. Every other row on the student
 * goes too - a supervisor left over from when the board stored a coach and
 * supervisor PAIR (2026-08-10 to 2026-10-01) is not a second coach to keep, and
 * the one-row-per-student key would refuse the insert while it stood. Only a
 * replaced COACH is named in `previous`, because that is the change a reader
 * asked for.
 *
 * Does not open a transaction. The single assignment wraps one call and the
 * import wraps all of its calls in one, so a half-applied import cannot happen.
 *
 * @return array{result: string, previous: string[]} result is assigned,
 *               reassigned or unchanged; previous names whoever was replaced
 */
function student_set_coach(PDO $pdo, int $studentId, int $coachUserId, int $assignedByUserId, ?string $notes = null): array
{
    $coachRoleIds = student_coach_role_ids();

    // LEFT JOIN, so a row whose account is gone is cleared as well.
    $current = $pdo->prepare(
        "SELECT sa.assignment_id, sa.caller_user_id, u.role AS role_id,
                TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS name
           FROM ssp_assignment sa
      LEFT JOIN user u ON u.user_id = sa.caller_user_id
          WHERE sa.student_id = ?"
    );
    $current->execute([$studentId]);
    $rows = $current->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $alreadyTheirs = false;
    $replaced = [];
    $removeIds = [];
    foreach ($rows as $row) {
        if ((int)$row['caller_user_id'] === $coachUserId) {
            $alreadyTheirs = true;
            continue;
        }
        $removeIds[] = (int)$row['assignment_id'];
        if (in_array((int)($row['role_id'] ?? 0), $coachRoleIds, true)) {
            $replaced[] = (string)$row['name'];
        }
    }

    if ($alreadyTheirs && !$removeIds) {
        return ['result' => 'unchanged', 'previous' => []];
    }

    if ($removeIds) {
        $idPlaceholders = implode(',', array_fill(0, count($removeIds), '?'));
        $pdo->prepare("DELETE FROM ssp_assignment WHERE assignment_id IN ($idPlaceholders)")->execute($removeIds);
    }

    if (!$alreadyTheirs) {
        $insert = $pdo->prepare(
            'INSERT INTO ssp_assignment (student_id, caller_user_id, assigned_by_user_id, notes)
             VALUES (:student_id, :caller_user_id, :assigned_by_user_id, :notes)'
        );
        $insert->execute([
            ':student_id' => $studentId,
            ':caller_user_id' => $coachUserId,
            ':assigned_by_user_id' => $assignedByUserId,
            ':notes' => $notes,
        ]);
    }

    // Clearing a leftover supervisor under a coach who stays is not a change
    // of coach, so it reads as unchanged rather than as a fresh assignment.
    return [
        'result' => $replaced ? 'reassigned' : ($alreadyTheirs ? 'unchanged' : 'assigned'),
        'previous' => $replaced,
    ];
}
