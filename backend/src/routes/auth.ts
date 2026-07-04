import { Router, Request, Response } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { JWT_SECRET } from "../lib/jwt";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { pbkdf2Sync } from "crypto";

function deriveVaultKeyForBackend(password: string, saltHex: string): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  return pbkdf2Sync(password, salt, 200000, 32, "sha256");
}

const router = Router();

const createToken = (userId: string, email: string) => {
  const tokenExpiresIn = (process.env.JWT_EXPIRES_IN || "7d") as import("jsonwebtoken").SignOptions["expiresIn"];
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: tokenExpiresIn });
};

const resolveSalt = (salt?: unknown) => {
  if (typeof salt === "string" && salt.trim().length > 0) {
    return salt.trim();
  }

  return randomBytes(16).toString("hex");
};

// POST /api/auth/register
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { email, password, salt } = req.body;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail || typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "Email and password with at least 8 characters required" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      res.status(409).json({ error: "Email is already registered" });
      return;
    }

    const passwordHash = await argon2.hash(password);
    const resolvedSalt = resolveSalt(salt);

    const user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, salt: resolvedSalt },
    });

    const recoveryKey = randomBytes(32).toString("hex");

    const vaultKey = deriveVaultKeyForBackend(password, resolvedSalt);

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(recoveryKey, "hex"), iv);
    const encrypted = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedVaultKey = Buffer.concat([encrypted, authTag]).toString("base64");
    const encryptedVaultKeyIv = iv.toString("base64");

    await prisma.user.update({
      where: { id: user.id },
      data: { encryptedVaultKey, encryptedVaultKeyIv },
    });

    const token = createToken(user.id, user.email);

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email },
      salt: user.salt,
      recoveryKey,
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail || typeof password !== "string" || password.length === 0) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = createToken(user.id, user.email);

    res.json({
      token,
      user: { id: user.id, email: user.email },
      salt: user.salt,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId as string },
      select: { id: true, email: true, createdAt: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/change-password", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await argon2.verify(user.passwordHash, oldPassword);
    if (!valid) return res.status(401).json({ error: "Old password incorrect" });

    const newSalt = randomBytes(16).toString("hex");
    const newPasswordHash = await argon2.hash(newPassword);

    const newVaultKey = deriveVaultKeyForBackend(newPassword, newSalt);
    const recoveryKey = randomBytes(32).toString("hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(recoveryKey, "hex"), iv);
    const encrypted = Buffer.concat([cipher.update(newVaultKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const newEncryptedVaultKey = Buffer.concat([encrypted, authTag]).toString("base64");
    const newEncryptedVaultKeyIv = iv.toString("base64");

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        salt: newSalt,
        encryptedVaultKey: newEncryptedVaultKey,
        encryptedVaultKeyIv: newEncryptedVaultKeyIv,
      },
    });

    res.json({ ok: true, newSalt, recoveryKey });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-with-recovery", async (req: Request, res: Response) => {
  try {
    const { email, recoveryKey, newMasterPassword } = req.body;

    if (!email || !recoveryKey || !newMasterPassword) {
      res.status(400).json({ error: "Email, recovery key, and new password are required." });
      return;
    }

    if (typeof newMasterPassword !== "string" || newMasterPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (!user) {
      res.status(401).json({ error: "Invalid recovery key or email." });
      return;
    }

    if (!user.encryptedVaultKey || !user.encryptedVaultKeyIv) {
      res.status(400).json({ error: "No recovery key is set up for this account." });
      return;
    }

    let oldVaultKey: Buffer;
    try {
      const iv = Buffer.from(user.encryptedVaultKeyIv, "base64");
      const encryptedBlob = Buffer.from(user.encryptedVaultKey, "base64");

      const authTag = encryptedBlob.slice(-16);
      const ciphertext = encryptedBlob.slice(0, -16);

      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(recoveryKey, "hex"),
        iv
      );
      decipher.setAuthTag(authTag);

      oldVaultKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      res.status(401).json({ error: "Invalid recovery key or email." });
      return;
    }

    const newSalt = randomBytes(16).toString("hex");
    const newPasswordHash = await argon2.hash(newMasterPassword);
    const newVaultKey = deriveVaultKeyForBackend(newMasterPassword, newSalt);
    const newRecoveryKey = randomBytes(32).toString("hex");
    const newIv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(newRecoveryKey, "hex"),
      newIv
    );
    const encryptedNewVaultKey = Buffer.concat([
      cipher.update(newVaultKey),
      cipher.final(),
    ]);
    const newAuthTag = cipher.getAuthTag();
    const encryptedVaultKeyB64 = Buffer.concat([encryptedNewVaultKey, newAuthTag]).toString("base64");

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        salt: newSalt,
        encryptedVaultKey: encryptedVaultKeyB64,
        encryptedVaultKeyIv: newIv.toString("base64"),
      },
    });

    const token = createToken(user.id, user.email);

    res.json({
      ok: true,
      token,
      newSalt,
      vaultKey: oldVaultKey.toString("base64"),
      newRecoveryKey,
    });
  } catch (error) {
    console.error("Reset with recovery error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

export default router;