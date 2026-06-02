import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { extractHostname, normalizeDomain } from "../lib/domain";

const router = Router();

router.use(authMiddleware);

// POST /api/credentials — shto kredencial të ri
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { domain, ciphertext, iv } = req.body;

    if (!domain || !ciphertext || !iv) {
      res.status(400).json({ error: "domain, ciphertext dhe iv janë të nevojshme" });
      return;
    }

    const normalized = normalizeDomain(domain);
    if (!normalized) {
      res.status(400).json({ error: "domain është i pavlefshëm" });
      return;
    }

    const credential = await prisma.credential.create({
      data: {
        userId: req.userId as string,
        domain: normalized,
        ciphertext,
        iv,
      },
    });

    res.status(201).json(credential);
  } catch (error) {
    console.error("Create credential error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/credentials — merr të gjitha kredencialet e userit
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const credentials = await prisma.credential.findMany({
      where: { userId: req.userId as string },
      orderBy: { createdAt: "desc" },
    });

    res.json(credentials);
  } catch (error) {
    console.error("Get credentials error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/credentials/domain/:domain — merr kredencialet për një domain
router.get("/domain/:domain", async (req: AuthRequest, res: Response) => {
  try {
    const rawHostname = extractHostname(req.params.domain);
    const normalized = normalizeDomain(req.params.domain);

    if (!rawHostname && !normalized) {
      res.json([]);
      return;
    }

    const candidates = Array.from(new Set([rawHostname, normalized].filter(Boolean))) as string[];

    const credentials = await prisma.credential.findMany({
      where: {
        userId: req.userId as string,
        domain: { in: candidates },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(credentials);
  } catch (error) {
    console.error("Get by domain error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/credentials/:id — përditëso kredencial
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { domain, ciphertext, iv } = req.body;

    const existing = await prisma.credential.findFirst({
      where: { id: req.params.id, userId: req.userId as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Kredenciali nuk u gjet" });
      return;
    }

    const data: { domain?: string; ciphertext?: string; iv?: string } = {};

    if (typeof domain !== "undefined") {
      const normalized = normalizeDomain(domain);
      if (!normalized) {
        res.status(400).json({ error: "domain është i pavlefshëm" });
        return;
      }
      data.domain = normalized;
    }

    if (typeof ciphertext !== "undefined") {
      data.ciphertext = ciphertext;
    }

    if (typeof iv !== "undefined") {
      data.iv = iv;
    }

    const updated = await prisma.credential.update({
      where: { id: req.params.id },
      data,
    });

    res.json(updated);
  } catch (error) {
    console.error("Update credential error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/credentials/:id — fshi kredencial
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.credential.findFirst({
      where: { id: req.params.id, userId: req.userId as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Kredenciali nuk u gjet" });
      return;
    }

    await prisma.credential.delete({ where: { id: req.params.id } });

    res.json({ message: "Kredenciali u fshi me sukses" });
  } catch (error) {
    console.error("Delete credential error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;