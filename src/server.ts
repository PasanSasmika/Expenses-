import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Transaction } from "./models/Transaction.js";
import { User } from "./models/User.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || "";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function monthRange(month?: string) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(year, monthNumber - 1, 1);
  const end = new Date(year, monthNumber, 1);
  return { $gte: start, $lt: end };
}

function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
}

function readCredentials(body: unknown) {
  const { email, password } = (body || {}) as { email?: unknown; password?: unknown };
  return {
    email: typeof email === "string" ? email.trim().toLowerCase() : "",
    password: typeof password === "string" ? password : "",
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string };
    if (!payload.sub || !mongoose.isValidObjectId(payload.sub)) throw new Error("Invalid token");
    res.locals.userId = new mongoose.Types.ObjectId(payload.sub);
    next();
  } catch {
    res.status(401).json({ message: "Please log in again." });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "Pocket Expense API" });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = readCredentials(req.body);
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }
    // bcrypt ignores everything past 72 bytes, so cap the length instead of silently truncating.
    if (password.length < 8 || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ message: "Password must be between 8 and 72 characters." });
    }
    if (await User.exists({ email })) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 12) });
    // Transactions saved before accounts existed have no owner; hand them to the first account.
    if ((await User.countDocuments()) === 1) {
      await Transaction.updateMany({ user: { $exists: false } }, { $set: { user: user._id } });
    }
    res.status(201).json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    res.status(500).json({ message: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = readCredentials(req.body);
    const user = email && password ? await User.findOne({ email }) : null;
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }
    res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
  } catch {
    res.status(500).json({ message: "Could not log in." });
  }
});

app.get("/api/auth/me", requireAuth, async (_req, res) => {
  try {
    const user = await User.findById(res.locals.userId);
    if (!user) return res.status(401).json({ message: "Please log in again." });
    res.json({ id: user.id, email: user.email });
  } catch {
    res.status(500).json({ message: "Could not load account." });
  }
});

app.get("/api/transactions", requireAuth, async (req, res) => {
  try {
    const dateRange = monthRange(String(req.query.month || ""));
    const type = String(req.query.type || "");
    const filter: Record<string, unknown> = { user: res.locals.userId };
    if (dateRange) filter.date = dateRange;
    if (type === "income" || type === "expense") filter.type = type;
    const transactions = await Transaction.find(filter).sort({ date: -1, createdAt: -1 }).lean();
    res.json(transactions);
  } catch {
    res.status(500).json({ message: "Could not load transactions." });
  }
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  try {
    const { type, name, amount, date } = req.body as {
      type?: string; name?: string; amount?: number; date?: string;
    };
    const parsedAmount = Number(amount);
    if (!["income", "expense"].includes(type || "") ||
        typeof name !== "string" || !name.trim() ||
        !Number.isFinite(parsedAmount) || parsedAmount <= 0 ||
        !date || Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ message: "Enter a valid type, name, amount, and date." });
    }
    const transaction = await Transaction.create({
      user: res.locals.userId, type, name: name.trim(), amount: parsedAmount, date: new Date(date),
    });
    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ message: "Could not save transaction." });
  }
});

app.delete("/api/transactions/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await Transaction.findOneAndDelete({ _id: req.params.id, user: res.locals.userId });
    if (!deleted) return res.status(404).json({ message: "Transaction not found." });
    res.status(204).send();
  } catch {
    res.status(400).json({ message: "Invalid transaction ID." });
  }
});

app.get("/api/summary", requireAuth, async (req, res) => {
  try {
    const dateRange = monthRange(String(req.query.month || ""));
    const filter: Record<string, unknown> = { user: res.locals.userId };
    if (dateRange) filter.date = dateRange;
    const totals = await Transaction.aggregate([
      { $match: filter },
      { $group: {
        _id: "$type",
        total: { $sum: "$amount" },
        count: { $sum: 1 }
      }}
    ]);
    const income = totals.find((item) => item._id === "income")?.total || 0;
    const expenses = totals.find((item) => item._id === "expense")?.total || 0;
    res.json({ income, expenses, balance: income - expenses });
  } catch {
    res.status(500).json({ message: "Could not calculate summary." });
  }
});

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error("Missing MONGODB_URI. Copy .env.example to .env and configure it.");
    process.exit(1);
  }
  if (!JWT_SECRET) {
    console.error("Missing JWT_SECRET. Set a long random secret in .env.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  app.listen(PORT, "0.0.0.0", () => console.log(`Pocket Expense API running on port ${PORT}`));
}

start().catch((error) => {
  console.error("Failed to start API:", error);
  process.exit(1);
});
