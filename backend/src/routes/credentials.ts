import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { extractHostname, normalizeDomain } from "../lib/domain";

const router = Router();

router.use(authMiddleware);

// POST /api/credentials — create new credential
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { domain, ciphertext, iv } = req.body;

    if (!domain || !ciphertext || !iv) {
      res.status(400).json({ error: "domain, ciphertext, and iv are required." });
      return;
    }

    const normalized = normalizeDomain(domain);
    if (!normalized) {
      res.status(400).json({ error: "Invalid domain." });
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
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/credentials — get all credentials for the user
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const credentials = await prisma.credential.findMany({
      where: { userId: req.userId as string },
      orderBy: { createdAt: "desc" },
    });

    res.json(credentials);
  } catch (error) {
    console.error("Get credentials error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/credentials/domain/:domain — get credentials for a specific domain
router.get("/domain/:domain", async (req: AuthRequest, res: Response) => {
  try {
    const rawHostname = extractHostname(req.params.domain);
    const normalized = normalizeDomain(req.params.domain);

    if (!rawHostname && !normalized) {
      res.json([]);
      return;
    }

    const candidates = Array.from(
      new Set([rawHostname, normalized].filter(Boolean))
    ) as string[];

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
    res.status(500).json({ error: "Server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/credentials/bulk — MUST be defined before /:id
//
// If /bulk is placed after router.put("/:id", ...), Express will match the
// literal string "bulk" as an :id parameter and this route is never reached.
// The update silently returns { ok: true, updatedCount: 0 } while credentials
// remain encrypted with the old key, causing the vault to appear empty after
// a master password change or recovery.
// ─────────────────────────────────────────────────────────────────────────────
router.put("/bulk", async (req: AuthRequest, res: Response) => {
  try {
    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: "updates must be a non-empty array." });
      return;
    }

    const userId = req.userId as string;

    // Validate that every update belongs to this user before touching anything
    const ids = updates.map((u) => u.id).filter(Boolean);
    const owned = await prisma.credential.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((c) => c.id));

    const validUpdates = updates.filter(
      (u) =>
        ownedIds.has(u.id) &&
        typeof u.ciphertext === "string" &&
        typeof u.iv === "string"
    );

    if (validUpdates.length === 0) {
      // Nothing to update (e.g. user has no credentials yet — that's fine)
      res.json({ ok: true, updatedCount: 0 });
      return;
    }

    const results = await prisma.$transaction(
      validUpdates.map(({ id, ciphertext, iv }) =>
        prisma.credential.update({
          where: { id },
          data: { ciphertext, iv },
        })
      )
    );

    res.json({ ok: true, updatedCount: results.length });
  } catch (error) {
    console.error("Bulk update error:", error);
    res.status(500).json({ error: "Bulk update failed." });
  }
});

// PUT /api/credentials/:id — update a single credential
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { domain, ciphertext, iv } = req.body;

    const existing = await prisma.credential.findFirst({
      where: { id: req.params.id, userId: req.userId as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Credential not found." });
      return;
    }

    const data: { domain?: string; ciphertext?: string; iv?: string } = {};

    if (typeof domain !== "undefined") {
      const normalized = normalizeDomain(domain);
      if (!normalized) {
        res.status(400).json({ error: "Invalid domain." });
        return;
      }
      data.domain = normalized;
    }

    if (typeof ciphertext !== "undefined") data.ciphertext = ciphertext;
    if (typeof iv !== "undefined") data.iv = iv;

    const updated = await prisma.credential.update({
      where: { id: req.params.id },
      data,
    });

    res.json(updated);
  } catch (error) {
    console.error("Update credential error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/credentials/:id — delete a credential
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.credential.findFirst({
      where: { id: req.params.id, userId: req.userId as string },
    });

    if (!existing) {
      res.status(404).json({ error: "Credential not found." });
      return;
    }

    await prisma.credential.delete({ where: { id: req.params.id } });

    res.json({ message: "Credential deleted successfully." });
  } catch (error) {
    console.error("Delete credential error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

export default router;