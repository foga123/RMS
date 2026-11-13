<?php
/**
 * A survey asks each question once, and a question offers each choice once.
 *
 * Survey titles are unique too; that check lives beside the survey endpoint as
 * survey_duplicate_title_error(). These are the other two, shared by
 * survey_question.php and survey_question_option.php, plus the one test every
 * survey endpoint needs for the database refusing a duplicate.
 *
 * Each check compares with plain `=`, the same comparison the unique index
 * makes (migrations/2026_09_25_survey_uniqueness.sql): the columns are
 * utf8mb4_general_ci, so "Yes", "yes" and "YES" are one choice. Comparing any
 * other way would let the check and the index disagree about what counts as
 * the same, and the index would then answer with a 500 instead of a sentence.
 */

if (!function_exists('survey_is_duplicate_key')) {

    /**
     * Was this the database refusing a duplicate (MariaDB 1062)?
     *
     * The checks below run first, so this is reached only when two saves race
     * or a comparison slips past them. The caller answers 409, not 500.
     */
    function survey_is_duplicate_key(Throwable $e): bool
    {
        return $e instanceof PDOException && (int)($e->errorInfo[1] ?? 0) === 1062;
    }

    /** Another question in this survey with the same wording, as a sentence; null when there is none. */
    function survey_question_duplicate_error(PDO $pdo, int $surveyId, string $text, ?int $excludeId = null): ?string
    {
        $sql = 'SELECT question_id FROM survey_question WHERE survey_id = :survey AND question_text = :text';
        $params = [':survey' => $surveyId, ':text' => $text];
        if ($excludeId !== null) {
            $sql .= ' AND question_id <> :exclude';
            $params[':exclude'] = $excludeId;
        }
        $stmt = $pdo->prepare($sql . ' LIMIT 1');
        $stmt->execute($params);
        $clash = $stmt->fetchColumn();
        if ($clash === false) {
            return null;
        }

        return 'This survey already asks "' . $text . '" (question #' . (int)$clash
            . '). Each question in a survey must be different.';
    }

    /** Another choice on this question with the same wording, as a sentence; null when there is none. */
    function survey_option_duplicate_error(PDO $pdo, int $questionId, string $text, ?int $excludeId = null): ?string
    {
        $sql = 'SELECT option_id FROM survey_question_option WHERE question_id = :question AND option_text = :text';
        $params = [':question' => $questionId, ':text' => $text];
        if ($excludeId !== null) {
            $sql .= ' AND option_id <> :exclude';
            $params[':exclude'] = $excludeId;
        }
        $stmt = $pdo->prepare($sql . ' LIMIT 1');
        $stmt->execute($params);
        if ($stmt->fetchColumn() === false) {
            return null;
        }

        return 'This question already has the choice "' . $text . '". Each choice must be different.';
    }

    /**
     * The first choice listed twice in a list about to be saved, or null.
     *
     * Lowercased and trimmed, which is how the index compares for anything
     * typed on a keyboard here. It does not fold accents ("Oo" and "Óo") the
     * way the collation does; the index still refuses those, and the save
     * answers 409 with survey_option_list_clash_message().
     */
    function survey_option_list_repeat(array $texts): ?string
    {
        $seen = [];
        foreach ($texts as $text) {
            $key = mb_strtolower(trim((string)$text), 'UTF-8');
            if (isset($seen[$key])) {
                return (string)$text;
            }
            $seen[$key] = true;
        }
        return null;
    }

    function survey_option_list_clash_message(?string $text = null): string
    {
        return $text !== null
            ? '"' . $text . '" is listed twice. Each choice must be different.'
            : 'Two of these choices read the same. Each choice must be different.';
    }

    /** A refusal from survey_options_replace(), raised after its transaction is rolled back. */
    final class SurveyOptionReplaceError extends RuntimeException
    {
        public int $status;

        public function __construct(int $status, string $message)
        {
            parent::__construct($message);
            $this->status = $status;
        }
    }

    /**
     * Save a question's whole list of choices at once: PUT ?question_id=N with
     * {"options": [{"option_id", "option_text", "enrollment_status_id"}, ...]}.
     *
     * The survey editor used to send one request per choice - update, add, then
     * delete - and with choices now unique that order breaks ordinary edits:
     * swapping "Yes" and "No" collides on the first update, and removing "Yes"
     * then adding it back collides on the add. It also left a half-saved list
     * behind whenever a request in the middle failed.
     *
     * So the list is checked as a whole (no choice twice) and applied in one
     * transaction: removed choices go first, renamed ones are parked under a text
     * nobody types before taking their new wording, then new ones are added. A
     * refusal changes nothing.
     *
     * The list arrives validated (survey_question_option.php checks each choice's
     * text and enrolment mapping); this checks it as a whole and applies it.
     *
     * Permissions stay what the separate requests needed: adding a choice needs
     * `create` and removing one needs `delete` (removing a choice removes the
     * answers filed under it), besides the `edit` this PUT was let in with.
     */
    function survey_options_replace(PDO $pdo, int $questionId, array $clean, bool $mayCreate, bool $mayRemove): void
    {
        $repeat = survey_option_list_repeat(array_column($clean, 'option_text'));
        if ($repeat !== null) {
            throw new SurveyOptionReplaceError(409, survey_option_list_clash_message($repeat));
        }

        $pdo->beginTransaction();
        try {
            $read = $pdo->prepare(
                'SELECT option_id, option_text, enrollment_status_id FROM survey_question_option
                  WHERE question_id = :question FOR UPDATE'
            );
            $read->execute([':question' => $questionId]);
            $existing = [];
            foreach ($read->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $existing[(int)$row['option_id']] = $row;
            }

            $kept = [];
            $added = [];
            foreach ($clean as $entry) {
                if ($entry['option_id'] === 0) {
                    $added[] = $entry;
                    continue;
                }
                if (!isset($existing[$entry['option_id']])) {
                    throw new SurveyOptionReplaceError(400, 'Choice #' . $entry['option_id'] . ' is not on this question.');
                }
                if (isset($kept[$entry['option_id']])) {
                    throw new SurveyOptionReplaceError(400, 'Choice #' . $entry['option_id'] . ' is listed twice.');
                }
                $kept[$entry['option_id']] = $entry;
            }

            $removed = array_values(array_diff(array_keys($existing), array_keys($kept)));
            if ($removed && !$mayRemove) {
                throw new SurveyOptionReplaceError(403, 'You do not have permission to remove answer choices.');
            }
            if ($added && !$mayCreate) {
                throw new SurveyOptionReplaceError(403, 'You do not have permission to add answer choices.');
            }

            if ($removed) {
                $in = implode(',', array_fill(0, count($removed), '?'));
                $pdo->prepare("DELETE FROM survey_question_option WHERE option_id IN ($in)")->execute($removed);
            }

            // Compared exactly, so a change of case ("yes" -> "Yes") is saved too.
            $renamed = array_filter(
                $kept,
                static fn(array $entry, int $id): bool => $entry['option_text'] !== (string)$existing[$id]['option_text'],
                ARRAY_FILTER_USE_BOTH
            );
            if ($renamed) {
                $park = $pdo->prepare('UPDATE survey_question_option SET option_text = :text WHERE option_id = :id');
                $token = "\u{1}" . bin2hex(random_bytes(6));
                foreach (array_keys($renamed) as $id) {
                    $park->execute([':text' => $token . '#' . $id, ':id' => $id]);
                }
            }

            $update = $pdo->prepare(
                'UPDATE survey_question_option SET option_text = :text, enrollment_status_id = :status WHERE option_id = :id'
            );
            foreach ($kept as $id => $entry) {
                $statusWas = $existing[$id]['enrollment_status_id'] === null ? null : (int)$existing[$id]['enrollment_status_id'];
                if (isset($renamed[$id]) || $statusWas !== $entry['enrollment_status_id']) {
                    $update->execute([':text' => $entry['option_text'], ':status' => $entry['enrollment_status_id'], ':id' => $id]);
                }
            }

            $insert = $pdo->prepare(
                'INSERT INTO survey_question_option (question_id, option_text, enrollment_status_id)
                 VALUES (:question, :text, :status)'
            );
            foreach ($added as $entry) {
                $insert->execute([':question' => $questionId, ':text' => $entry['option_text'], ':status' => $entry['enrollment_status_id']]);
            }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
