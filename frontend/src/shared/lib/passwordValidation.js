// Client-side password validation that mirrors the backend
// `api_validate_password_strength()` in backend/api/middleware/auth.php so the
// two never disagree. The backend remains the source of truth; this only gives
// the user immediate feedback before the request is sent.

import { getMaxPasswordLength } from "./securityPolicy";

export const PASSWORD_MIN_LENGTH = 8;

// Kept in sync with the backend blocklist (whole-password, case-insensitive).
const COMMON_PASSWORDS = new Set([
  "123", "1234", "12345", "123456", "1234567", "12345678",
  "password", "admin", "admin123", "qwerty", "abc123",
  "letmein", "welcome", "monkey", "dragon", "master",
]);

// Error messages mirror the backend strings, in the same evaluation order.
const RULE_MESSAGES = {
  length: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
  uppercase: "Password must contain at least one uppercase letter",
  lowercase: "Password must contain at least one lowercase letter",
  number: "Password must contain at least one number",
  common: "This password is too common. Please choose a stronger password",
};

/**
 * Returns the individual requirement checks (for a live checklist UI).
 * Order matches the backend so the first failing item is the message shown.
 */
export function getPasswordChecks(password) {
  const value = String(password ?? "");
  return [
    { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, passed: value.length >= PASSWORD_MIN_LENGTH },
    { id: "uppercase", label: "One uppercase letter (A–Z)", passed: /[A-Z]/.test(value) },
    { id: "lowercase", label: "One lowercase letter (a–z)", passed: /[a-z]/.test(value) },
    { id: "number", label: "One number (0–9)", passed: /[0-9]/.test(value) },
    { id: "common", label: "Not a commonly used password", passed: value.length > 0 && !COMMON_PASSWORDS.has(value.toLowerCase()) },
  ];
}

/**
 * Validate a password against the strength rules plus the configured maximum
 * length. Returns { valid, error, checks, maxLength }.
 */
export function validatePassword(password) {
  const value = String(password ?? "");
  const checks = getPasswordChecks(value);
  const maxLength = getMaxPasswordLength();

  for (const check of checks) {
    if (!check.passed) {
      return { valid: false, error: RULE_MESSAGES[check.id], checks, maxLength };
    }
  }
  if (value.length > maxLength) {
    return { valid: false, error: `Password exceeds maximum length (${maxLength}).`, checks, maxLength };
  }
  return { valid: true, error: null, checks, maxLength };
}
