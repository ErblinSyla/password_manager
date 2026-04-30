const rawSecret = process.env.JWT_SECRET;

const looksLikePlaceholder =
  typeof rawSecret === "string" &&
  /zgjedh_nje_sekret|vendos_ketu|change-me/i.test(rawSecret);

const looksWeak =
  typeof rawSecret === "string" &&
  (rawSecret.trim().length < 32 || looksLikePlaceholder);

if (!rawSecret) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production.");
  }

  console.warn(
    "JWT_SECRET is not set. Using a development-only fallback secret."
  );
} else if (looksWeak) {
  const message =
    "JWT_SECRET looks weak or placeholder. Set a long random secret (>= 32 chars).";
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(message);
}

export const JWT_SECRET = rawSecret ?? "dev-secret-change-me";