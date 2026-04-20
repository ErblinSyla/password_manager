import { Router, Request, Response } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { JWT_SECRET } from "../lib/jwt";

const router = Router();

const createToken = (userId: string, email: string) =>
  jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "7d" });

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
      res.status(400).json({ error: "Email dhe një password me të paktën 8 karaktere janë të nevojshme" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      res.status(409).json({ error: "Ky email është i regjistruar" });
      return;
    }

    const passwordHash = await argon2.hash(password);
    const resolvedSalt = resolveSalt(salt);

    const user = await prisma.user.create({
      data: { email: normalizedEmail, passwordHash, salt: resolvedSalt },
    });

    const token = createToken(user.id, user.email);

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email },
      salt: user.salt,
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
      res.status(400).json({ error: "Email dhe password janë të nevojshme" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      res.status(401).json({ error: "Email ose password i gabuar" });
      return;
    }

    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      res.status(401).json({ error: "Email ose password i gabuar" });
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
      res.status(404).json({ error: "Përdoruesi nuk u gjet" });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;