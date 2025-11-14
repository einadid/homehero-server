import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const app = express();

// CORS
const allowedOrigins =
  process.env.CLIENT_ORIGIN?.split(",").map(s => s.trim()).filter(Boolean) ||
  ["http://localhost:5173"];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// MongoDB connect (cached for serverless)
const MONGODB_URI = process.env.MONGODB_URI;
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };
async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, { dbName: "homehero", bufferCommands: false })
      .then(m => m.connection);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Schemas & Models
const ReviewSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true },
  date: { type: Date, default: Date.now }
});

const ServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  description: { type: String, required: true, trim: true },
  image: { type: String, required: true },
  providerName: { type: String, required: true, trim: true },
  providerEmail: { type: String, required: true, lowercase: true, trim: true },
  ratingAvg: { type: Number, default: 0 },
  reviews: [ReviewSchema]
}, { timestamps: true });

const BookingSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
  bookingDate: { type: Date, required: true },
  price: { type: Number, required: true, min: 0 }
}, { timestamps: true });

const Service = mongoose.models.Service || mongoose.model("Service", ServiceSchema);
const Booking = mongoose.models.Booking || mongoose.model("Booking", BookingSchema);

// Health
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.send({ ok: true, message: "HomeHero API is running" }));

// Ensure DB
app.use(async (req, res, next) => {
  try { await connectDB(); next(); } catch (e) { next(e); }
});

/* Services */
// Create
app.post("/services", async (req, res) => {
  try {
    const { name, category, price, description, image, providerName, providerEmail } = req.body;
    if (!name || !category || price == null || !description || !image || !providerName || !providerEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const doc = await Service.create({ name, category, price, description, image, providerName, providerEmail });
    res.status(201).json(doc);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// List with filters/pagination/sort/limit
app.get("/services", async (req, res) => {
  try {
    const { search, category, providerEmail, minPrice, maxPrice, sort, page = 1, limit = 12 } = req.query;
    const q = {};
    if (providerEmail) q.providerEmail = providerEmail.toLowerCase();
    if (category) q.category = category;
    if (search) {
      q.$or = [
        { name: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } }
      ];
    }
    if (minPrice || maxPrice) {
      q.price = {};
      if (minPrice) q.price.$gte = Number(minPrice);
      if (maxPrice) q.price.$lte = Number(maxPrice);
    }
    const lim = Math.min(Number(limit) || 12, 50);
    const skip = (Number(page) - 1) * lim;

    let cur = Service.find(q);
    if (sort === "priceAsc") cur = cur.sort({ price: 1 });
    if (sort === "priceDesc") cur = cur.sort({ price: -1 });
    if (sort === "ratingDesc") cur = cur.sort({ ratingAvg: -1, createdAt: -1 });
    if (sort === "createdDesc") cur = cur.sort({ createdAt: -1 });

    const [items, total] = await Promise.all([cur.skip(skip).limit(lim), Service.countDocuments(q)]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / lim) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Single
app.get("/services/:id", async (req, res) => {
  try {
    const item = await Service.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch { res.status(400).json({ message: "Invalid id" }); }
});

// Update (owner)
app.patch("/services/:id", async (req, res) => {
  try {
    const requester = (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });
    if (requester && requester !== doc.providerEmail) return res.status(403).json({ message: "Forbidden: not owner" });

    const updatable = ["name", "category", "price", "description", "image"];
    const updates = {};
    updatable.forEach(k => { if (k in req.body) updates[k] = req.body[k]; });

    const updated = await Service.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json(updated);
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Delete (owner)
app.delete("/services/:id", async (req, res) => {
  try {
    const requester = (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });
    if (requester && requester !== doc.providerEmail) return res.status(403).json({ message: "Forbidden: not owner" });
    await Service.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Add/Update Review (booked users only)
app.post("/services/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;
    const { userEmail, rating, comment } = req.body;
    if (!userEmail || !rating) return res.status(400).json({ message: "userEmail and rating required" });

    const booked = await Booking.findOne({ userEmail: userEmail.toLowerCase(), serviceId: id });
    if (!booked) return res.status(403).json({ message: "Only booked users can review" });

    const svc = await Service.findById(id);
    if (!svc) return res.status(404).json({ message: "Service not found" });

    const idx = svc.reviews.findIndex(r => r.userEmail === userEmail.toLowerCase());
    if (idx >= 0) {
      svc.reviews[idx].rating = Number(rating);
      svc.reviews[idx].comment = comment || svc.reviews[idx].comment;
      svc.reviews[idx].date = new Date();
    } else {
      svc.reviews.push({ userEmail: userEmail.toLowerCase(), rating: Number(rating), comment: comment || "" });
    }
    const sum = svc.reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    svc.ratingAvg = svc.reviews.length ? Number((sum / svc.reviews.length).toFixed(2)) : 0;

    await svc.save();
    res.status(201).json({ ok: true, ratingAvg: svc.ratingAvg, reviews: svc.reviews });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Top rated
app.get("/top-services", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 12);
    const items = await Service.find({}).sort({ ratingAvg: -1, createdAt: -1 }).limit(limit);
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Provider summary (optional: profile stats)
app.get("/provider/summary", async (req, res) => {
  try {
    const email = (req.query.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "email required" });

    const totalServices = await Service.countDocuments({ providerEmail: email });
    const services = await Service.find({ providerEmail: email }).select("_id ratingAvg");
    const serviceIds = services.map(s => s._id);

    const bookingsAgg = await Booking.aggregate([
      { $match: { serviceId: { $in: serviceIds } } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$price" } } }
    ]);
    const totalBookings = bookingsAgg[0]?.count || 0;
    const totalRevenue = bookingsAgg[0]?.revenue || 0;
    const avgRating =
      services.length ? Number((services.reduce((a, b) => a + (b.ratingAvg || 0), 0) / services.length).toFixed(2)) : 0;

    res.json({ totalServices, totalBookings, totalRevenue, avgRating });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/* Bookings */
app.post("/bookings", async (req, res) => {
  try {
    const { userEmail, serviceId, bookingDate, price } = req.body;
    if (!userEmail || !serviceId || !bookingDate || price == null)
      return res.status(400).json({ message: "Missing required fields" });

    const svc = await Service.findById(serviceId);
    if (!svc) return res.status(404).json({ message: "Service not found" });
    if (svc.providerEmail.toLowerCase() === userEmail.toLowerCase())
      return res.status(403).json({ message: "You cannot book your own service" });

    const b = await Booking.create({
      userEmail: userEmail.toLowerCase(),
      serviceId,
      bookingDate: new Date(bookingDate),
      price: Number(price)
    });
    res.status(201).json(b);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get("/bookings", async (req, res) => {
  try {
    const { userEmail } = req.query;
    if (!userEmail) return res.status(400).json({ message: "userEmail required" });
    const items = await Booking.find({ userEmail: userEmail.toLowerCase() })
      .sort({ createdAt: -1 })
      .populate("serviceId", "name image providerName providerEmail price");
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete("/bookings/:id", async (req, res) => {
  try {
    const { userEmail } = req.query;
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ message: "Booking not found" });
    if (userEmail && b.userEmail !== userEmail.toLowerCase())
      return res.status(403).json({ message: "Forbidden" });
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
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
    } catch (e) { console.error("Failed to start server:", e); }
  })();
}