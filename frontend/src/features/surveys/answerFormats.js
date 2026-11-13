/**
 * What a text answer is allowed to look like.
 *
 * A survey question can now say that its answer is a name, a whole number or a
 * mobile number, and this is the one place that decides what each of those
 * means. The rules are mirrored in backend/api/lib/survey_answer_format.php,
 * which is the authority - the browser copy exists so a student is told before
 * they press Submit, not after a round trip. answerFormats.test.js reads the
 * PHP patterns out of that file and fails if the two ever disagree.
 *
 * Only text questions carry a format. Radio, checkbox and rating answers come
 * from a fixed list the author wrote, so there is nothing left to constrain.
 */

/**
 * The pattern strings are shared with PHP verbatim, so they are written to be
 * legal in both engines:
 *   \p{L}  - any Unicode letter, so Ñ and é are letters rather than symbols
 *   \x27   - an apostrophe, spelled as a code point to avoid one file quoting
 *            it differently from the other and drifting apart silently
 */
/**
 * Said once, filled in with the limit that applies.
 *
 * A template rather than four sentences so the wording cannot drift between
 * formats, or between this file and the PHP one.
 */
export const ANSWER_LENGTH_MESSAGE = "Keep this answer to %d characters or fewer.";

export const ANSWER_FORMATS = {
  any: {
    key: "any",
    label: "Any text",
    pattern: "",
    // Long enough for a paragraph and nowhere near the 65,535 bytes the column
    // holds. The longest answer this survey has ever collected is 58
    // characters; this is the ceiling, not the expectation.
    maxLength: 1000,
    hint: "",
    message: "",
  },
  letters: {
    key: "letters",
    label: "Letters only (no numbers)",
    // The lookahead is what stops "..." and "---" from counting as a name: at
    // least one actual letter has to be in there.
    pattern: "^(?=.*\\p{L})[\\p{L}\\s.\\x27-]+$",
    maxLength: 100,
    hint: "Letters only - no numbers.",
    message: "Use letters only - no numbers.",
  },
  number: {
    key: "number",
    label: "Numbers only",
    pattern: "^\\d+$",
    maxLength: 10,
    hint: "Numbers only.",
    message: "Use numbers only.",
  },
  phone: {
    key: "phone",
    label: "Mobile number (09XXXXXXXXX)",
    pattern: "^09\\d{9}$",
    maxLength: 11,
    hint: "11 digits starting with 09 - e.g. 09362743710",
    message: "Use an 11-digit mobile number starting with 09, e.g. 09362743710.",
  },

  /*
   * How much room the answer gets, when the shape does not matter.
   *
   * Three sizes rather than a number the author types, because the useful
   * question is "a phrase, a sentence or a paragraph?" and not "how many
   * characters exactly?".
   *
   * "any" keeps its historical 1000 rather than being folded into one of these:
   * every question written before this existed carries it, and moving that
   * ceiling would silently change what those questions accept.
   */
  short: {
    key: "short",
    label: "Short answer (a word or a phrase)",
    pattern: "",
    maxLength: 100,
    hint: "A word or a phrase.",
    message: "",
  },
  medium: {
    key: "medium",
    label: "Medium answer (a sentence or two)",
    pattern: "",
    maxLength: 400,
    hint: "A sentence or two.",
    message: "",
  },
  long: {
    key: "long",
    label: "Long answer (a paragraph)",
    pattern: "",
    maxLength: 1500,
    hint: "A paragraph.",
    message: "",
  },

  /*
   * A Philippine address, assembled by AddressPicker rather than typed. The
   * value is one composed line - "street, Brgy. barangay, city, province ZIP" - so
   * everything downstream (export, the answers panel, the risk engine) reads it
   * as the string it always was.
   */
  address: {
    key: "address",
    label: "Philippine address (street, barangay, city, province, ZIP)",
    pattern: "",
    maxLength: 250,
    hint: "Type the street, pick the province, city and barangay, then add the ZIP code.",
    message: "",
  },
};

/** Formats the student answers through a picker instead of a text box. */
export const COMPOSED_ANSWER_FORMATS = ["address"];

export function isComposedAnswerFormat(format) {
  return COMPOSED_ANSWER_FORMATS.includes(normalizeAnswerFormat(format));
}

/*
 * ---------------------------------------------------------------------------
 * What the author picks, versus what the database stores.
 *
 * An address is stored as question_type 'text' with answer_format 'address',
 * which keeps it out of the question_type enum and out of a migration. But that
 * is a storage decision, and it leaked into the editor: "Address" was reachable
 * only by choosing Text first and then opening a dropdown labelled "Accepted
 * answer". Nobody looking to ask for an address opens the Text type and goes
 * hunting - they look at the list of question types, do not find it, and
 * conclude the feature is not there.
 *
 * So the editor offers one flat list - the real types plus one entry per
 * composed format - and translates. The three functions below are that
 * translation, and they are here rather than in the page so that adding a
 * composed format adds its type option automatically.
 * ---------------------------------------------------------------------------
 */

/**
 * The stored question types, in the order the editor lists them.
 *
 * Named for what the STUDENT does, not for the HTML input behind it. "Radio"
 * and "Checkbox" are the names of controls; an author writing a survey is
 * deciding whether one answer may be picked or several, and had to already know
 * the jargon to choose correctly. The `value` is untouched -- it is what the
 * database stores and what every test pins.
 *
 * The hint matters most on "Choose one": branching can only read a question
 * whose answers are a fixed list, and an author who picks Text first has to
 * work out for themselves why the condition box stays empty.
 */
export const BASE_QUESTION_TYPES = [
  { value: "text", label: "Text answer", hint: "The student types it themselves." },
  {
    value: "radio",
    label: "Choose one",
    hint: "One answer from a list you write. Other questions can be shown or hidden based on which one they pick.",
  },
  {
    value: "checkbox",
    label: "Choose any number",
    hint: "Any number of answers from a list you write, including none.",
  },
  { value: "rating", label: "Rating", hint: "A score on a scale." },
];

/** Everything the author may pick, stored types and composed formats together. */
export function questionTypeOptions() {
  return [
    ...BASE_QUESTION_TYPES,
    ...COMPOSED_ANSWER_FORMATS.map((key) => ({
      value: key,
      label: ANSWER_FORMATS[key].label.replace(/\s*\(.*\)$/, ""),
      hint: ANSWER_FORMATS[key].hint || "",
      composed: true,
    })),
  ];
}

/** Which entry in that list a stored question is currently showing as. */
export function editorTypeOf(questionType, answerFormat) {
  const type = String(questionType ?? "text").trim().toLowerCase();
  if (type !== "text") return type;
  const format = normalizeAnswerFormat(answerFormat);
  return isComposedAnswerFormat(format) ? format : "text";
}

/** What to store when the author picks one. */
export function storedTypeFor(editorType) {
  const key = String(editorType ?? "text").trim().toLowerCase();
  if (isComposedAnswerFormat(key)) {
    return { question_type: "text", answer_format: key };
  }
  // Only a text answer can carry a shape; every other type answers itself from
  // the option list. Either way the format resets — switching type is the
  // author changing their mind, and carrying a phone-number rule across into a
  // question that is no longer about a phone number would be a rule they never
  // set and cannot see.
  return { question_type: key, answer_format: "any" };
}

/**
 * The formats the "Accepted answer" dropdown offers.
 *
 * Composed ones are excluded: they are their own entry in the type list now, and
 * leaving them in both places would let an author set the same thing two ways
 * and see the two controls disagree.
 */
export function selectableAnswerFormatKeys() {
  return ANSWER_FORMAT_KEYS.filter((key) => !isComposedAnswerFormat(key));
}

/**
 * Formats that are one line by definition, and so get an input rather than a
 * textarea.
 *
 * Listed rather than derived from maxLength. The two nearly agree today and
 * would drift the moment somebody raised a limit: "short" is one line because a
 * word or a phrase is one line, not because it happens to cap at 100. A name, a
 * number and a mobile number are one line for the same reason.
 */
export const SINGLE_LINE_ANSWER_FORMATS = ["letters", "number", "phone", "short"];

export function isSingleLineAnswerFormat(format) {
  return SINGLE_LINE_ANSWER_FORMATS.includes(normalizeAnswerFormat(format));
}

/** Formats where a phone keypad is the right keyboard on a handset. */
export function answerInputMode(format) {
  return ["number", "phone"].includes(normalizeAnswerFormat(format)) ? "numeric" : "text";
}

export const ANSWER_FORMAT_KEYS = Object.keys(ANSWER_FORMATS);

/** Anything unrecognised is "any", so an older row is never treated as invalid. */
export function normalizeAnswerFormat(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ANSWER_FORMATS, key) ? key : "any";
}

/**
 * The format actually in force for a question.
 *
 * A format left behind on a question that was later switched to radio is
 * ignored rather than applied to an option label the author already chose.
 */
export function answerFormatOfQuestion(question, questionType) {
  const type = String(questionType ?? question?.question_type ?? "text").trim().toLowerCase();
  if (type !== "text") return "any";
  return normalizeAnswerFormat(question?.answer_format);
}

export function answerFormatRule(format) {
  return ANSWER_FORMATS[normalizeAnswerFormat(format)];
}

/**
 * Keep what the student typed, drop what the format cannot hold.
 *
 * Applied on every keystroke so a letters-only field simply refuses digits
 * rather than accepting them and complaining later. Pasting is the case worth
 * caring about: "+63 936 274 3710" and "0936-274-3710" both come out as
 * 09362743710 instead of being truncated into a different number.
 */
export function sanitizeAnswerInput(format, value, customLimit) {
  const key = normalizeAnswerFormat(format);
  const raw = String(value ?? "");
  let cleaned;

  switch (key) {
    case "letters":
      cleaned = raw.replace(/[^\p{L}\s.\x27-]/gu, "");
      break;
    case "number":
      cleaned = raw.replace(/\D/g, "");
      break;
    case "phone": {
      let digits = raw.replace(/\D/g, "");
      // A pasted +63 number is the same number written for international
      // dialling; 63 + nine digits after the leading 9 is unambiguous.
      if (digits.startsWith("63") && digits.length === 12) digits = `0${digits.slice(2)}`;
      cleaned = digits;
      break;
    }
    default:
      cleaned = raw;
  }

  return cleaned.slice(0, effectiveAnswerMaxLength(key, customLimit));
}

/** The format's own ceiling, before any per-question limit. */
export function answerMaxLength(format) {
  return answerFormatRule(format).maxLength;
}

/**
 * How long an answer to this question may actually be.
 *
 * The format sets a natural ceiling; an author may narrow it per question with a
 * custom limit. The limit only shrinks the field, never grows it: the effective
 * cap is min(limit, the format ceiling), so a limit set while a question was
 * "long" cannot leave a wider field behind once it is switched to "short". A
 * blank or non-positive limit means "use the format default". Mirrors
 * survey_answer_effective_max_length() in the PHP authority.
 */
export function effectiveAnswerMaxLength(format, customLimit) {
  const base = answerMaxLength(format);
  const limit = Math.floor(Number(customLimit));
  if (Number.isFinite(limit) && limit > 0) return Math.min(limit, base);
  return base;
}

/** How much room is left, for the counter shown as the limit gets close. */
export function answerLengthMessage(format, customLimit) {
  return ANSWER_LENGTH_MESSAGE.replace("%d", String(effectiveAnswerMaxLength(format, customLimit)));
}

/**
 * "" when the value is acceptable, otherwise the reason it is not.
 *
 * A blank value is acceptable here whatever the format says. Whether an answer
 * may be blank at all is the `is_required` question, decided separately - and
 * answering "this is not a phone number" about an empty box would be nonsense.
 */
export function validateAnswerValue(format, value, customLimit) {
  const rule = answerFormatRule(format);
  const text = String(value ?? "").trim();
  if (text === "") return "";

  // The shape first, because it is the more specific complaint. A twelve-digit
  // phone number breaks both rules, and "use an 11-digit number starting with
  // 09" tells the student what to do where "keep it to 11 characters" only
  // tells them to delete something.
  if (rule.pattern && !new RegExp(rule.pattern, "u").test(text)) return rule.message;

  // Length is what is left: the only thing wrong with a thousand-word answer to
  // a free-text question. Counted in characters, not bytes - a limit that moved
  // depending on how many accented letters were used would be impossible to
  // explain, and the column has room to spare either way.
  if (text.length > effectiveAnswerMaxLength(rule.key, customLimit)) {
    return answerLengthMessage(rule.key, customLimit);
  }

  return "";
}
