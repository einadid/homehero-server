import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";

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

// MongoDB connect (cached for serverless)
const MONGODB_URI = process.env.MONGODB_URI;
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: "homehero",
        bufferCommands: false,
      })
      .then((m) => m.connection);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Schemas & Models
const ReviewSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  rating: { type: Number, min: 1, max: 5 },
  comment: { type: String, trim: true },
  date: { type: Date, default: Date.now },
});

const ServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
    image: { type: String, required: true },
    providerName: { type: String, required: true, trim: true },
    providerEmail: { type: String, required: true, lowercase: true, trim: true },
    ratingAvg: { type: Number, default: 0 },
    reviews: [ReviewSchema],
  },
  { timestamps: true }
);

const BookingSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, lowercase: true, trim: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
    bookingDate: { type: Date, required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

const Service = mongoose.models.Service || mongoose.model("Service", ServiceSchema);
const Booking = mongoose.models.Booking || mongoose.model("Booking", BookingSchema);

// Health
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.send({ ok: true, message: "HomeHero API is running" }));

// Ensure DB before handling routes
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (e) {
    next(e);
  }
});

/* ---------------- Services Routes ---------------- */
app.post("/services", async (req, res) => {
  try {
    const { name, category, price, description, image, providerName, providerEmail } = req.body;
    if (!name || !category || price == null || !description || !image || !providerName || !providerEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const service = await Service.create({
      name, category, price, description, image, providerName, providerEmail,
    });
    res.status(201).json(service);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/services", async (req, res) => {
  try {
    const { search, category, providerEmail, minPrice, maxPrice, sort, page = 1, limit = 12 } = req.query;

    const q = {};
    if (providerEmail) q.providerEmail = providerEmail.toLowerCase();
    if (category) q.category = category;
    if (search) {
      q.$or = [
        { name: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }
    if (minPrice || maxPrice) {
      q.price = {};
      if (minPrice) q.price.$gte = Number(minPrice);
      if (maxPrice) q.price.$lte = Number(maxPrice);
    }

    const skip = (Number(page) - 1) * Number(limit);
    let cursor = Service.find(q);

    if (sort === "priceAsc") cursor = cursor.sort({ price: 1 });
    if (sort === "priceDesc") cursor = cursor.sort({ price: -1 });
    if (sort === "ratingDesc") cursor = cursor.sort({ ratingAvg: -1 });

    const [items, total] = await Promise.all([
      cursor.skip(skip).limit(Number(limit)),
      Service.countDocuments(q),
    ]);

    res.json({ items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/services/:id", async (req, res) => {
  try {
    const item = await Service.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: "Invalid id" });
  }
});

app.patch("/services/:id", async (req, res) => {
  try {
    const requester = (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });
    if (requester && requester !== doc.providerEmail) {
      return res.status(403).json({ message: "Forbidden: not owner" });
    }

    const updatable = ["name", "category", "price", "description", "image"];
    const updates = {};
    updatable.forEach((k) => {
      if (k in req.body) updates[k] = req.body[k];
    });

    const updated = await Service.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete("/services/:id", async (req, res) => {
  try {
    const requester = (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });
    if (requester && requester !== doc.providerEmail) {
      return res.status(403).json({ message: "Forbidden: not owner" });
    }
    await Service.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* ---------------- Bookings Routes ---------------- */
app.post("/bookings", async (req, res) => {
  try {
    const { userEmail, serviceId, bookingDate, price } = req.body;
    if (!userEmail || !serviceId || !bookingDate || price == null) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const svc = await Service.findById(serviceId);
    if (!svc) return res.status(404).json({ message: "Service not found" });
    if (svc.providerEmail.toLowerCase() === userEmail.toLowerCase()) {
      return res.status(403).json({ message: "You cannot book your own service" });
    }
    const booking = await Booking.create({
      userEmail: userEmail.toLowerCase(),
      serviceId,
      bookingDate: new Date(bookingDate),
      price: Number(price),
    });
    res.status(201).json(booking);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/bookings", async (req, res) => {
  try {
    const { userEmail } = req.query;
    if (!userEmail) return res.status(400).json({ message: "userEmail required" });
    const items = await Booking.find({ userEmail: userEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .populate("serviceId", "name image providerName providerEmail price");
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete("/bookings/:id", async (req, res) => {
  try {
    const { userEmail } = req.query;
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ message: "Booking not found" });
    if (userEmail && b.userEmail !== userEmail.toLowerCase()) {
      return res.status(403).json({ message: "Forbidden" });
    }
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

export default app;

// Local dev
const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  (async () => {
    try {
      await connectDB();
      app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
    } catch (e) {
      console.error("Failed to start server:", e);
    }
  })();
}