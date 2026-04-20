export const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

if (!process.env.JWT_SECRET) {
  console.warn("JWT_SECRET is not set. Using a development-only fallback secret.");
}