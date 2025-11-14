// index.js (root)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db/connect.js";
import servicesRouter from "./routes/services.routes.js";
import bookingsRouter from "./routes/bookings.routes.js";

dotenv.config();

const app = express();

// CORS
const allowedOrigins =
  process.env.CLIENT_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ||
  ["http://localhost:5173"];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

// Health routes (DB connect দরকার নেই)
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) =>
  res.send({ ok: true, message: "HomeHero API is running" })
);

// প্রতিটা রুট হিটের আগে DB কানেক্ট নিশ্চিত (cached)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (e) {
    next(e);
  }
});

// API routes
app.use("/services", servicesRouter);
app.use("/bookings", bookingsRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

export default app;

// Local dev server
const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  (async () => {
    try {
      await connectDB();
      app.listen(port, () =>
        console.log(`Server running on http://localhost:${port}`)
      );
    } catch (e) {
      console.error("Failed to start server:", e);
    }
  })();
}