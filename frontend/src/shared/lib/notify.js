import Swal from "sweetalert2";

const ARCHIVE_CONFIRM_BUTTON_COLOR = "#a16207";

const DEFAULT_CONFIRM_OPTIONS = {
  icon: "warning",
  title: "Are you sure?",
  text: "",
  confirmButtonText: "Yes",
  cancelButtonText: "Cancel",
  confirmButtonColor: "#dc2626",
  cancelButtonColor: "#475569",
  showCancelButton: true,
  reverseButtons: true,
};

export function notify(options = {}) {
  return Swal.fire(options);
}

export function notifyInfo(title, text = "", options = {}) {
  return notify({ icon: "info", title, text, ...options });
}

export function notifySuccess(title, text = "", options = {}) {
  return notify({ icon: "success", title, text, ...options });
}

export function notifyError(title, text = "", options = {}) {
  return notify({ icon: "error", title, text, ...options });
}

export function notifyWarning(title, text = "", options = {}) {
  return notify({ icon: "warning", title, text, ...options });
}

export async function confirmAction(options = {}) {
  const mergedOptions = { ...DEFAULT_CONFIRM_OPTIONS, ...options };
  if (String(mergedOptions.confirmButtonText || "").trim().toLowerCase() === "archive") {
    mergedOptions.confirmButtonColor = ARCHIVE_CONFIRM_BUTTON_COLOR;
  }
  const result = await notify(mergedOptions);
  return Boolean(result?.isConfirmed);
}

/**
 * A confirmation that also asks for a short piece of text - the reason for an
 * act that has to be explained later, such as reopening a closed semester.
 *
 * Resolves to the trimmed text, or null when cancelled. An empty answer is
 * refused inside the dialog when `required`, so the caller never has to.
 */
export async function promptText({ required = true, maxLength = 255, inputLabel = "", placeholder = "", ...options } = {}) {
  const result = await notify({
    ...DEFAULT_CONFIRM_OPTIONS,
    input: "textarea",
    inputLabel,
    inputPlaceholder: placeholder,
    inputAttributes: { maxlength: String(maxLength), "aria-label": inputLabel || "Reason" },
    inputValidator: (value) => (required && !String(value || "").trim() ? "Please write the reason." : undefined),
    ...options,
  });
  if (!result?.isConfirmed) return null;
  return String(result.value || "").trim();
}
