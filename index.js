import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();

app.use(cors({
  origin: (process.env.CLIENT_ORIGIN?.split(",") || ["http://localhost:5173"]),
  credentials: true
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.send({ ok: true, message: "HomeHero API is running" });
});
app.get("/healthz", (req, res) => res.status(200).send("ok"));

export default app;

const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}