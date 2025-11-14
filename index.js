// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db/connect.js";
import servicesRouter from "./routes/services.routes.js";
import bookingsRouter from "./routes/bookings.routes.js";

dotenv.config();
const app = express();

app.use(cors({
  origin: (process.env.CLIENT_ORIGIN?.split(",") || ["http://localhost:5173"]),
  credentials: true
}));
app.use(express.json());

// Ensure DB connected before routes
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (e) {
    next(e);
  }
});

app.get("/", (req, res) => res.send({ ok: true, message: "HomeHero API is running" }));
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.use("/services", servicesRouter);
app.use("/bookings", bookingsRouter);

// Global error handler (so you see proper JSON instead of function crash page)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

export default app;

// local dev only
const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}