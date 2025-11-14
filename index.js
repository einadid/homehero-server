// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db/connect.js";
import servicesRouter from "./routes/services.routes.js";
import bookingsRouter from "./routes/bookings.routes.js"; // নতুন বুকিং রাউটার

dotenv.config();
const app = express();

// CORS setup
app.use(cors({
  origin: (process.env.CLIENT_ORIGIN?.split(",") || ["http://localhost:5173"]),
  credentials: true
}));

app.use(express.json());

// Health check routes
app.get("/", (req, res) => res.send({ ok: true, message: "HomeHero API is running" }));
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// API routes
app.use("/services", servicesRouter);
app.use("/bookings", bookingsRouter); // বুকিং রাউটার যোগ

// Connect DB and start server
connectDB().catch((e) => console.error(e));

const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

export default app;
