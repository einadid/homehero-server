import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import admin from "firebase-admin";

dotenv.config();

const app = express();

// Security & Perf
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(morgan("tiny"));

// CORS
const allowedOrigins =
  process.env.CLIENT_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ||
  ["http://localhost:5173"];
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// MongoDB (cached)
const MONGODB_URI = process.env.MONGODB_URI;
let cached = global.mongoose;
if (!cached) cached = (global.mongoose = { conn: null, promise: null });
async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, { dbName: "homehero", bufferCommands: false })
      .then((m) => m.connection);
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Firebase Admin (token verify)
const VERIFY_TOKEN = String(process.env.VERIFY_TOKEN || "false") === "true";
function initAdmin() {
  try {
    if (admin.apps.length) return;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
      console.warn("Firebase Admin not configured; token verify disabled.");
      return;
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
    });
    console.log("Firebase Admin initialized");
  } catch (e) {
    console.warn("Firebase Admin init failed:", e.message);
  }
}
initAdmin();

async function verifyAuth(req, res, next) {
  try {
    if (!VERIFY_TOKEN || !admin.apps.length) return next();
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Missing Authorization token" });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// Schemas
const ReviewSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true },
  date: { type: Date, default: Date.now }
});

const ServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, index: true, unique: true, sparse: true },
  category: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0, index: true },
  description: { type: String, required: true, trim: true },
  image: { type: String, required: true },
  providerName: { type: String, required: true, trim: true },
  providerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  ratingAvg: { type: Number, default: 0, index: true },
  reviews: [ReviewSchema],
  views: { type: Number, default: 0, index: true }
}, { timestamps: true });
ServiceSchema.index({ name: "text", category: "text" });

const BookingSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true, index: true },
  bookingDate: { type: Date, required: true, index: true },
  price: { type: Number, required: true, min: 0 }
}, { timestamps: true });
BookingSchema.index({ userEmail: 1, serviceId: 1, bookingDate: 1 }, { unique: true });

const FavoriteSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true, index: true }
}, { timestamps: true });
FavoriteSchema.index({ userEmail: 1, serviceId: 1 }, { unique: true });

const Service = mongoose.models.Service || mongoose.model("Service", ServiceSchema);
const Booking = mongoose.models.Booking || mongoose.model("Booking", BookingSchema);
const Favorite = mongoose.models.Favorite || mongoose.model("Favorite", FavoriteSchema);

// Utils
const slugify = (s) =>
  s?.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "";
async function uniqueSlugForNew(name) {
  const base = slugify(name);
  let slug = base, i = 2;
  while (await Service.exists({ slug })) slug = `${base}-${i++}`;
  return slug;
}
async function uniqueSlugForUpdate(name, id) {
  const base = slugify(name);
  let slug = base, i = 2;
  while (await Service.exists({ slug, _id: { $ne: id } })) slug = `${base}-${i++}`;
  return slug;
}

// Health
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.send({ ok: true, message: "HomeHero API is running" }));

// Ensure DB
app.use(async (req, res, next) => {
  try { await connectDB(); next(); } catch (e) { next(e); }
});

/* Public: Services list/filter */
app.get("/services", async (req, res) => {
  try {
    const { search, category, providerEmail, minPrice, maxPrice, sort, page = 1, limit = 12 } = req.query;
    const q = {};
    if (providerEmail) q.providerEmail = String(providerEmail).toLowerCase();
    if (category) q.category = category;
    if (search) q.$or = [
      { name: { $regex: search, $options: "i" } },
      { category: { $regex: search, $options: "i" } },
    ];
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

// Single + by slug + trending/top
app.get("/services/:id", async (req, res) => {
  try {
    const item = await Service.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch { res.status(400).json({ message: "Invalid id" }); }
});

app.get("/s/:slug", async (req, res) => {
  try {
    const item = await Service.findOneAndUpdate({ slug: req.params.slug }, { $inc: { views: 1 } }, { new: true });
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch { res.status(400).json({ message: "Invalid slug" }); }
});

app.get("/top-services", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 12);
    const items = await Service.find({}).sort({ ratingAvg: -1, createdAt: -1 }).limit(limit);
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 12);
    const items = await Service.find({}).sort({ views: -1, createdAt: -1 }).limit(limit);
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Provider stats/analytics
app.get("/provider/summary", async (req, res) => {
  try {
    const email = String(req.query.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "email required" });
    const totalServices = await Service.countDocuments({ providerEmail: email });
    const services = await Service.find({ providerEmail: email }).select("_id ratingAvg");
    const serviceIds = services.map((s) => s._id);
    const agg = await Booking.aggregate([
      { $match: { serviceId: { $in: serviceIds } } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$price" } } }
    ]);
    const totalBookings = agg[0]?.count || 0;
    const totalRevenue = agg[0]?.revenue || 0;
    const avgRating =
      services.length ? Number((services.reduce((a, b) => a + (b.ratingAvg || 0), 0) / services.length).toFixed(2)) : 0;
    res.json({ totalServices, totalBookings, totalRevenue, avgRating });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get("/provider/analytics", async (req, res) => {
  try {
    const email = String(req.query.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "email required" });
    const services = await Service.find({ providerEmail: email }).select("_id");
    const serviceIds = services.map((s) => s._id);
    if (!serviceIds.length) return res.json({ series: [] });

    const agg = await Booking.aggregate([
      { $match: { serviceId: { $in: serviceIds } } },
      { $group: {
          _id: { y: { $year: "$bookingDate" }, m: { $month: "$bookingDate" } },
          bookings: { $sum: 1 },
          revenue: { $sum: "$price" }
      }},
      { $sort: { "_id.y": 1, "_id.m": 1 } }
    ]);
    const series = agg.map(r => ({
      month: `${r._id.y}-${String(r._id.m).padStart(2, "0")}`,
      bookings: r.bookings, revenue: r.revenue
    }));
    res.json({ series });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/* PROTECTED ROUTES (require token if VERIFY_TOKEN=true) */

// Create service (provider = token user)
app.post("/services", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (!tokenEmail && VERIFY_TOKEN) return res.status(401).json({ message: "Unauthorized" });

    const { name, category, price, description, image } = req.body;
    const providerName = req.body.providerName || "Unknown";
    if (!name || !category || price == null || !description || !image)
      return res.status(400).json({ message: "Missing required fields" });

    const slug = await uniqueSlugForNew(name);
    const doc = await Service.create({
      name, slug, category, price, description, image,
      providerName, providerEmail: tokenEmail || req.body.providerEmail?.toLowerCase()
    });
    res.status(201).json(doc);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Update service (owner-only)
app.patch("/services/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });

    const requester = tokenEmail || (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    if (VERIFY_TOKEN && requester !== doc.providerEmail) return res.status(403).json({ message: "Forbidden: not owner" });

    const updatable = ["name", "category", "price", "description", "image"];
    const updates = {};
    updatable.forEach(k => { if (k in req.body) updates[k] = req.body[k]; });
    if (updates.name) updates.slug = await uniqueSlugForUpdate(updates.name, req.params.id);

    const updated = await Service.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json(updated);
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Delete service (owner-only)
app.delete("/services/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });

    const requester = tokenEmail || (req.query.providerEmail || req.body.providerEmail || "").toLowerCase();
    if (VERIFY_TOKEN && requester !== doc.providerEmail) return res.status(403).json({ message: "Forbidden: not owner" });

    await Service.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Book service (user must be token user)
app.post("/bookings", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (!tokenEmail && VERIFY_TOKEN) return res.status(401).json({ message: "Unauthorized" });

    const { serviceId, bookingDate, price } = req.body;
    if (!serviceId || !bookingDate || price == null)
      return res.status(400).json({ message: "Missing required fields" });

    const svc = await Service.findById(serviceId);
    if (!svc) return res.status(404).json({ message: "Service not found" });
    if (svc.providerEmail === tokenEmail)
      return res.status(403).json({ message: "You cannot book your own service" });

    const b = await Booking.create({
      userEmail: tokenEmail,
      serviceId,
      bookingDate: new Date(bookingDate),
      price: Number(price)
    });
    res.status(201).json(b);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: "Already booked this date" });
    res.status(500).json({ message: e.message });
  }
});

// Get user's bookings (token user only)
app.get("/bookings", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const userEmail = String(req.query.userEmail || "").toLowerCase();
    if (VERIFY_TOKEN && (!userEmail || userEmail !== tokenEmail))
      return res.status(403).json({ message: "Forbidden" });

    const items = await Booking.find({ userEmail: userEmail || tokenEmail })
      .sort({ createdAt: -1 })
      .populate("serviceId", "name image providerName providerEmail price");
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Cancel booking (owner-only)
app.delete("/bookings/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ message: "Booking not found" });
    if (VERIFY_TOKEN && b.userEmail !== tokenEmail) return res.status(403).json({ message: "Forbidden" });
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Reviews (booked users only; token user)
app.post("/services/:id/reviews", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (!tokenEmail && VERIFY_TOKEN) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { rating, comment } = req.body;
    if (!rating) return res.status(400).json({ message: "rating required" });

    const booked = await Booking.findOne({ userEmail: tokenEmail, serviceId: id });
    if (!booked) return res.status(403).json({ message: "Only booked users can review" });

    const svc = await Service.findById(id);
    if (!svc) return res.status(404).json({ message: "Service not found" });

    const idx = svc.reviews.findIndex((r) => r.userEmail === tokenEmail);
    if (idx >= 0) {
      svc.reviews[idx].rating = Number(rating);
      svc.reviews[idx].comment = comment || svc.reviews[idx].comment;
      svc.reviews[idx].date = new Date();
    } else {
      svc.reviews.push({ userEmail: tokenEmail, rating: Number(rating), comment: comment || "" });
    }
    const sum = svc.reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    svc.ratingAvg = svc.reviews.length ? Number((sum / svc.reviews.length).toFixed(2)) : 0;

    await svc.save();
    res.status(201).json({ ok: true, ratingAvg: svc.ratingAvg, reviews: svc.reviews });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

/* Favorites (protected) */
app.post("/favorites", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (!tokenEmail) return res.status(401).json({ message: "Unauthorized" });
    const { serviceId } = req.body;
    if (!serviceId) return res.status(400).json({ message: "serviceId required" });

    const fav = await Favorite.findOneAndUpdate(
      { userEmail: tokenEmail, serviceId },
      { $setOnInsert: { userEmail: tokenEmail, serviceId } },
      { upsert: true, new: true }
    );
    res.status(201).json(fav);
  } catch (e) {
    if (e.code === 11000) return res.status(200).json({ ok: true, note: "already" });
    res.status(500).json({ message: e.message });
  }
});

app.get("/favorites", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const items = await Favorite.find({ userEmail: tokenEmail }).populate("serviceId");
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.delete("/favorites/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Favorite.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Favorite not found" });
    if (doc.userEmail !== tokenEmail) return res.status(403).json({ message: "Forbidden" });
    await Favorite.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
});

// Global error
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

export default app;

// Local dev
const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  (async () => {
    try { await connectDB(); app.listen(port, () => console.log(`Server running on http://localhost:${port}`)); }
    catch (e) { console.error("Failed to start server:", e); }
  })();
}