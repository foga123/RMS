<?php
/**
 * Which students a Student Migration reader may see, as a WHERE clause.
 *
 * Lifted out of student_migration.php on 2026-10-06 so the year-end evaluation
 * (year_migration.php) reads exactly the same population. Two copies of a scope
 * rule are how a dean comes to see one set of students on the grid and apply a
 * year-level change to a different set.
 *
 * The clause is written against `s` (student) and `c` (course), so every caller
 * joins course as c. Nothing here emits a response; a refusal comes back as
 * `error` for the caller to send through its own responder.
 */

/** Roles that read every department rather than just their own. */
if (!defined('MIGRATION_ALL_DEPARTMENT_ROLES')) {
    define('MIGRATION_ALL_DEPARTMENT_ROLES', ['admin', 'ssg']);
}

function migration_scope(?array $authUser, array $query): array
{
    $isDepartmentPinned = api_user_is_department_pinned($authUser);
    $seesAllDepartments = api_session_user_has_role($authUser, MIGRATION_ALL_DEPARTMENT_ROLES);

    $departmentId = isset($query['department_id']) && $query['department_id'] !== ''
        ? (int)$query['department_id']
        : null;

    /*
     * Is $departmentId this account's OWN department, or one it asked for?
     *
     * Only the first widens across campuses. A dean is appointed to the
     * department and must see all of it; an admin who picks one row out of the
     * chooser means that row, and silently widening their filter would take
     * away the only way to look at a single campus.
     */
    $departmentScopeIsOwn = false;

    // A dean is pinned to their own department whatever the query string claims.
    if ($isDepartmentPinned && !$seesAllDepartments) {
        $departmentId = (int)($authUser['department_id'] ?? 0);
        if ($departmentId <= 0) {
            return ['error' => 'This account is not linked to a department'];
        }
        $departmentScopeIsOwn = true;
    } elseif (!$seesAllDepartments && $departmentId === null) {
        // Any other scoped role falls back to its own department rather than seeing everything.
        $ownDepartment = (int)($authUser['department_id'] ?? 0);
        $departmentId = $ownDepartment > 0 ? $ownDepartment : null;
        $departmentScopeIsOwn = $departmentId !== null;
    }

    /*
     * Campus is honoured only for viewers who already see every department.
     * A department belongs to one campus, so for anyone pinned to a department
     * the campus is already decided — offering it a second time could only
     * scope them to nothing. The department clause below still runs either way,
     * so naming another campus returns no rows rather than reaching into it.
     */
    $campusId = $seesAllDepartments && isset($query['campus_id']) && $query['campus_id'] !== ''
        ? (int)$query['campus_id']
        : null;

    $courseId = isset($query['course_id']) && $query['course_id'] !== '' ? (int)$query['course_id'] : null;
    $yearLevel = isset($query['year_level']) && $query['year_level'] !== '' ? (int)$query['year_level'] : null;
    $search = isset($query['search']) ? trim((string)$query['search']) : '';

    $scope = ['s.archived_at IS NULL'];
    $scopeParams = [];
    if ($campusId !== null && $campusId > 0) {
        $scope[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $scopeParams[':campus_id'] = $campusId;
    }
    if ($departmentId !== null && $departmentId > 0) {
        $scope[] = api_department_filter_sql('c.department_id', $departmentScopeIsOwn);
        $scopeParams[':department_id'] = $departmentId;
    }
    if ($courseId !== null && $courseId > 0) {
        $scope[] = 's.course_id = :course_id';
        $scopeParams[':course_id'] = $courseId;
    }
    if ($yearLevel !== null && $yearLevel > 0) {
        $scope[] = 's.year_level = :year_level';
        $scopeParams[':year_level'] = $yearLevel;
    }
    api_apply_student_type_scope($scope, $scopeParams, $authUser, 's.`star e-profile`', ':student_type_scope');

    return [
        'error' => null,
        'is_department_pinned' => $isDepartmentPinned,
        'sees_all_departments' => $seesAllDepartments,
        'department_id' => $departmentId,
        'department_is_own' => $departmentScopeIsOwn,
        'campus_id' => $campusId,
        'course_id' => $courseId,
        'year_level' => $yearLevel,
        'search' => $search,
        'clauses' => $scope,
        'params' => $scopeParams,
        'sql' => implode(' AND ', $scope),
    ];
}
