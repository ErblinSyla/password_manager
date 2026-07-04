import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import authRoutes from "./routes/auth";
import credentialRoutes from "./routes/credentials";

const app = express();
const PORT = Number(process.env.PORT || 3001) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const rawCorsOrigin = process.env.CORS_ORIGIN || "*";
const corsOrigin = rawCorsOrigin === "*"
  ? "*"
  : rawCorsOrigin.split(",").map((value) => value.trim()).filter(Boolean);
const corsMethods = (process.env.CORS_METHODS || "GET,POST,PUT,DELETE")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const corsAllowedHeaders = (process.env.CORS_ALLOWED_HEADERS || "Content-Type,Authorization")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin: corsOrigin,
  methods: corsMethods,
  allowedHeaders: corsAllowedHeaders,
}));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Server is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/credentials", credentialRoutes);

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

export default app;