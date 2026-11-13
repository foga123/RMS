/**
 * Sending a student file in batches instead of one row at a time.
 *
 * The importer used to POST once per student, serially, straight from the
 * browser. Against middleware/throttle.php — a burst of 120 requests, then 120
 * a minute, and 20 refusals inside a minute earning a ten-minute block — that
 * is fine for the twenty-row file somebody tests with and unusable for a real
 * registrar export:
 *
 *      1,000 rows = 1,000 requests. The burst is gone in seconds, twenty
 *      refusals follow immediately, the account is locked out for ten minutes,
 *      and because the loop caught each failure and carried on it kept firing
 *      for the rest of the file — writing an unpredictable prefix and blaming
 *      the data for hundreds of errors that were about rate limiting.
 *
 * A thousand rows per request turns that into one. 5,000 rows is 5 requests;
 * 100,000 is 100, which is still inside the burst.
 *
 * Two rules make it safe rather than merely faster:
 *
 *   - a 429 is honoured, not retried immediately. The server says how long to
 *     wait in `retry_after`; waiting once costs a single strike, where retrying
 *     in a loop is what earns the ten-minute block in the first place.
 *   - a batch that fails for any other reason stops the run. The old loop
 *     pressed on through failures, which is right when each failure is one bad
 *     row and wrong when it is the server refusing everything — there is no
 *     value in sending batch 40 after batches 1 to 39 were all rejected.
 */

/**
 * Rows per request. Matches STUDENTIMPORT_MAX_ROWS_PER_REQUEST in
 * student-import.php, which refuses anything larger; keeping the two in step
 * matters because the client is what decides the split.
 */
export const STUDENT_IMPORT_BATCH_SIZE = 1000;

/** How long to wait when the server refuses a batch and names no delay. */
const DEFAULT_RETRY_SECONDS = 30;

/** Give up rather than wait forever on a server that keeps saying "later". */
const MAX_RETRIES_PER_BATCH = 3;

/**
 * How long to wait after the connection drops, per attempt.
 *
 * Short and then longer: a laptop that changed Wi-Fi is usually back within
 * seconds, and a server that is genuinely down is not going to be helped by a
 * fourth request two seconds later.
 */
const RECONNECT_DELAYS_MS = [2000, 6000, 15000];

export function reconnectDelayMs(attempt) {
  const index = Math.max(1, Math.min(attempt, RECONNECT_DELAYS_MS.length)) - 1;
  return RECONNECT_DELAYS_MS[index];
}

export function chunkRows(rows, size = STUDENT_IMPORT_BATCH_SIZE) {
  const list = Array.isArray(rows) ? rows : [];
  const batches = [];
  for (let index = 0; index < list.length; index += size) {
    batches.push(list.slice(index, index + size));
  }
  return batches;
}

/**
 * How long the server asked us to wait, in milliseconds.
 *
 * `Retry-After` is a header and `retry_after` is in the JSON body; the throttle
 * sends both and either may be the one that survives a proxy. A missing or
 * nonsensical value falls back rather than becoming NaN — a NaN delay resolves
 * instantly and turns a polite retry into hammering.
 */
export function retryDelayMs(response, payload) {
  const header = Number(response?.headers?.get?.("Retry-After"));
  const body = Number(payload?.retry_after);
  const seconds = Number.isFinite(header) && header > 0
    ? header
    : Number.isFinite(body) && body > 0
      ? body
      : DEFAULT_RETRY_SECONDS;
  return Math.min(seconds, 600) * 1000;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Send every batch, in order, reporting as it goes.
 *
 * `send(batch)` performs one request and returns `{ response, payload }`.
 * `onProgress({ sent, total, batch, batches })` is called after each batch so a
 * dialog can say where it is — a 5,000-row import is several seconds of silence
 * otherwise, which reads as a hang.
 *
 * Returns the totals plus every row error the server reported, in file order.
 * Throws only when a batch fails for a reason that is not about one row: the
 * caller reports what was already written, because a run that stopped halfway
 * has still changed the database and saying otherwise would be a lie.
 */
export async function sendStudentBatches(rows, { send, onProgress, sleep = wait } = {}) {
  const batches = chunkRows(rows);
  const totals = { received: 0, inserted: 0, skipped: 0, accounts_created: 0, accounts_linked: 0 };
  const errors = [];
  let batchesSent = 0;

  for (const batch of batches) {
    let attempt = 0;

    for (;;) {
      let outcome;

      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await send(batch);
      } catch (transportError) {
        /*
         * The connection went away mid-batch — a dropped Wi-Fi, a laptop lid,
         * a proxy timing out. fetch() rejects rather than answering, so there
         * is no status to read and nothing to add up.
         *
         * Retrying is safe, and that is not an accident: student-import.php
         * rejects a student number that already exists, so a batch that
         * actually landed before the answer was lost comes back the second
         * time as "already exists" rather than creating anybody twice. Without
         * that guarantee this retry would be a duplicate-student generator.
         */
        if (attempt < MAX_RETRIES_PER_BATCH) {
          attempt += 1;
          // eslint-disable-next-line no-await-in-loop
          await sleep(reconnectDelayMs(attempt));
          continue;
        }

        const error = new Error(
          "The connection was lost and did not come back after " + MAX_RETRIES_PER_BATCH + " attempts."
        );
        error.offline = true;
        error.partial = { ...totals, errors, batchesSent, batches: batches.length };
        throw error;
      }

      const { response, payload } = outcome;

      if (response.status === 429 && attempt < MAX_RETRIES_PER_BATCH) {
        attempt += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs(response, payload));
        continue;
      }

      if (!response.ok) {
        const error = new Error(payload?.message || "The import stopped partway.");
        error.partial = { ...totals, errors, batchesSent, batches: batches.length };
        throw error;
      }

      const summary = payload?.summary || {};
      totals.received += Number(summary.received) || 0;
      totals.inserted += Number(summary.inserted) || 0;
      totals.skipped += Number(summary.skipped) || 0;
      totals.accounts_created += Number(summary.accounts_created) || 0;
      totals.accounts_linked += Number(summary.accounts_linked) || 0;
      errors.push(...(payload?.errors || []));

      batchesSent += 1;
      onProgress?.({ sent: totals.received, total: rows.length, batch: batchesSent, batches: batches.length });
      break;
    }
  }

  return { ...totals, errors, batches: batches.length };
}
