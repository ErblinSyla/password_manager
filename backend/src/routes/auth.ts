import { Router, Request, Response } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";

const router = Router();

// POST /api/auth/register
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { email, password, salt } = req.body;

    if (!email || !password || !salt) {
      res.status(400).json({ error: "Email, password dhe salt janë të nevojshme" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "Ky email është i regjistruar" });
      return;
    }

    const passwordHash = await argon2.hash(password);

    const user = await prisma.user.create({
      data: { email, passwordHash, salt },
    });

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET as string,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email },
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

    if (!email || !password) {
      res.status(400).json({ error: "Email dhe password janë të nevojshme" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: "Email ose password i gabuar" });
      return;
    }

    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      res.status(401).json({ error: "Email ose password i gabuar" });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET as string,
      { expiresIn: "7d" }
    );

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

export default router;