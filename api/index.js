// homehero-server/api/index.js
// Full serverless Express API for Vercel (with optional Firebase token verify, seed, diagnostics)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import admin from "firebase-admin";
import serverless from "serverless-http";

dotenv.config();

const app = express();

// ---------------- Security & Perf ----------------
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(morgan("tiny"));
app.use(express.json());

// ---------------- CORS ----------------
const allowedOrigins =
  process.env.CLIENT_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ||
  ["http://localhost:5173"];
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// ---------------- MongoDB (cached connect for serverless) ----------------
const MONGODB_URI = process.env.MONGODB_URI;
let cached = global.mongoose;
if (!cached) cached = (global.mongoose = { conn: null, promise: null });

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    if (!MONGODB_URI) {
      throw new Error("Missing MONGODB_URI env");
    }
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: "homehero",
        bufferCommands: false,
        serverSelectionTimeoutMS: 10000, // 10s
        connectTimeoutMS: 10000,
        socketTimeoutMS: 20000,
      })
      .then((m) => {
        console.log("MongoDB connected:", m.connection.host);
        return m.connection;
      })
      .catch((err) => {
        console.error("MongoDB connect error:", err.message);
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ---------------- Firebase Admin (optional token verify) ----------------
const VERIFY_TOKEN = String(process.env.VERIFY_TOKEN || "false") === "true";

function initAdmin() {
  try {
    if (admin.apps.length) return;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (!projectId || !clientEmail || !privateKey) {
      console.warn("Firebase Admin env not set; token verification disabled.");
      return;
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
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
    req.user = decoded; // decoded.email
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ---------------- Schemas & Models ----------------
const ReviewSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, lowercase: true, trim: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true },
  date: { type: Date, default: Date.now },
});

const ServiceSchema = new mongoose.Schema(
  {
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
    views: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);
ServiceSchema.index({ name: "text", category: "text" });

const BookingSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true, index: true },
    bookingDate: { type: Date, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);
// Prevent duplicate same-date booking by same user for same service
BookingSchema.index({ userEmail: 1, serviceId: 1, bookingDate: 1 }, { unique: true });

const FavoriteSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true, index: true },
  },
  { timestamps: true }
);
FavoriteSchema.index({ userEmail: 1, serviceId: 1 }, { unique: true });

const Service = mongoose.models.Service || mongoose.model("Service", ServiceSchema);
const Booking = mongoose.models.Booking || mongoose.model("Booking", BookingSchema);
const Favorite = mongoose.models.Favorite || mongoose.model("Favorite", FavoriteSchema);

// ---------------- Utils ----------------
const slugify = (s) =>
  s?.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "";

async function uniqueSlugForNew(name) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (await Service.exists({ slug })) slug = `${base}-${i++}`;
  return slug;
}
async function uniqueSlugForUpdate(name, id) {
  const base = slugify(name);
  let slug = base;
  let i = 2;
  while (await Service.exists({ slug, _id: { $ne: id } })) slug = `${base}-${i++}`;
  return slug;
}

// ---------------- Health & Diagnostics ----------------
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.get("/__db", async (req, res) => {
  try {
    await connectDB();
    const ping = await mongoose.connection.db.admin().command({ ping: 1 }).catch(() => ({ ok: 0 }));
    const total = await Service.estimatedDocumentCount().catch(() => null);
    res.json({ ok: true, mongo: { host: mongoose.connection.host, ping: ping.ok === 1 }, services: total });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------- TEMP Seed Routes (remove after use) ----------------
app.all("/__seed", async (req, res) => {
  try {
    const key = (req.query.key || req.body?.key || "").toString();
    if (!process.env.SEED_KEY || key !== process.env.SEED_KEY) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    await connectDB();

    const already = await Service.countDocuments();
    if (already > 0) {
      return res.status(400).json({ message: "DB already has data", total: already });
    }

    const samples = [
      {
        name: "AC Repair & Service",
        category: "Electrical",
        price: 1200,
        description: "Split/Window AC servicing, gas refill, and minor repairs.",
        image:
          "https://images.unsplash.com/photo-1581093588401-16ecce3b9f6b?q=80&w=1200&auto=format&fit=crop",
        providerName: "CoolFix",
        providerEmail: "coolfix@demo.com",
        ratingAvg: 4.7,
      },
      {
        name: "Deep Cleaning (2BHK)",
        category: "Cleaning",
        price: 3000,
        description: "Full home deep cleaning with eco-friendly supplies.",
        image:
          "https://images.unsplash.com/photo-1603715749720-5f28b4c81f01?q=80&w=1200&auto=format&fit=crop",
        providerName: "CleanPros",
        providerEmail: "clean@demo.com",
        ratingAvg: 4.8,
      },
      {
        name: "Plumbing Fix",
        category: "Plumbing",
        price: 800,
        description: "Leak fix, tap replacement, drain unclog.",
        image:
          "https://images.unsplash.com/photo-1581578017423-3b9b6a9a62da?q=80&w=1200&auto=format&fit=crop",
        providerName: "PipeMasters",
        providerEmail: "plumb@demo.com",
        ratingAvg: 4.5,
      },
      {
        name: "Electrician On-Demand",
        category: "Electrical",
        price: 600,
        description: "Fan, light, socket, MCB, wiring and more.",
        image:
          "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=1200&auto=format&fit=crop",
        providerName: "VoltCare",
        providerEmail: "electric@demo.com",
        ratingAvg: 4.6,
      },
    ];

    const docs = await Promise.all(
      samples.map(async (s) => ({ ...s, slug: await uniqueSlugForNew(s.name) }))
    );
    const result = await Service.insertMany(docs);
    const total = await Service.countDocuments();

    res.json({ seeded: result.length, total });
  } catch (e) {
    console.error("SEED error:", e);
    res.status(500).json({ message: e.message });
  }
});

// ---------------- Ensure DB for all API routes except healthz/seed/db ----------------
app.use(async (req, res, next) => {
  if (req.path === "/healthz" || req.path === "/__db" || req.path === "/__seed") return next();
  try {
    await connectDB();
    next();
  } catch (e) {
    next(e);
  }
});

// ---------------- Public APIs ----------------
app.get("/services", async (req, res) => {
  try {
    const { search, category, providerEmail, minPrice, maxPrice, sort, page = 1, limit = 12 } = req.query;

    const q = {};
    if (providerEmail) q.providerEmail = String(providerEmail).toLowerCase();
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

    const lim = Math.min(Number(limit) || 12, 50);
    const skip = (Number(page) - 1) * lim;

    let cur = Service.find(q);
    if (sort === "priceAsc") cur = cur.sort({ price: 1 });
    if (sort === "priceDesc") cur = cur.sort({ price: -1 });
    if (sort === "ratingDesc") cur = cur.sort({ ratingAvg: -1, createdAt: -1 });
    if (sort === "createdDesc") cur = cur.sort({ createdAt: -1 });

    const [items, total] = await Promise.all([cur.skip(skip).limit(lim), Service.countDocuments(q)]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / lim) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get("/services/:id", async (req, res) => {
  try {
    const item = await Service.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch {
    res.status(400).json({ message: "Invalid id" });
  }
});

app.get("/s/:slug", async (req, res) => {
  try {
    const item = await Service.findOneAndUpdate({ slug: req.params.slug }, { $inc: { views: 1 } }, { new: true });
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch {
    res.status(400).json({ message: "Invalid slug" });
  }
});

app.get("/top-services", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 12);
    const items = await Service.find({}).sort({ ratingAvg: -1, createdAt: -1 }).limit(limit);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 6, 12);
    const items = await Service.find({}).sort({ views: -1, createdAt: -1 }).limit(limit);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.get("/provider/summary", async (req, res) => {
  try {
    const email = String(req.query.email || "").toLowerCase();
    if (!email) return res.status(400).json({ message: "email required" });

    const totalServices = await Service.countDocuments({ providerEmail: email });
    const services = await Service.find({ providerEmail: email }).select("_id ratingAvg");
    const serviceIds = services.map((s) => s._id);

    const agg = await Booking.aggregate([
      { $match: { serviceId: { $in: serviceIds } } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$price" } } },
    ]);

    const totalBookings = agg[0]?.count || 0;
    const totalRevenue = agg[0]?.revenue || 0;
    const avgRating =
      services.length ? Number((services.reduce((a, b) => a + (b.ratingAvg || 0), 0) / services.length).toFixed(2)) : 0;

    res.json({ totalServices, totalBookings, totalRevenue, avgRating });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
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
      {
        $group: {
          _id: { y: { $year: "$bookingDate" }, m: { $month: "$bookingDate" } },
          bookings: { $sum: 1 },
          revenue: { $sum: "$price" },
        },
      },
      { $sort: { "_id.y": 1, "_id.m": 1 } },
    ]);

    const series = agg.map((r) => ({
      month: `${r._id.y}-${String(r._id.m).padStart(2, "0")}`,
      bookings: r.bookings,
      revenue: r.revenue,
    }));

    res.json({ series });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ---------------- PROTECTED APIs (require token if VERIFY_TOKEN=true) ----------------

// Create service (owner = token user when VERIFY_TOKEN=true)
app.post("/services", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const isProtected = VERIFY_TOKEN && !!tokenEmail;
    const {
      name,
      category,
      price,
      description,
      image,
      providerName = "Unknown",
      providerEmail,
    } = req.body;

    if (!name || !category || price == null || !description || !image) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const slug = await uniqueSlugForNew(name);
    const doc = await Service.create({
      name,
      slug,
      category,
      price,
      description,
      image,
      providerName,
      providerEmail: isProtected ? tokenEmail : (providerEmail || "").toLowerCase(),
    });

    res.status(201).json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Update (owner-only)
app.patch("/services/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });

    const requester = (VERIFY_TOKEN ? tokenEmail : (req.query.providerEmail || req.body.providerEmail || "")).toLowerCase();
    if (VERIFY_TOKEN && requester !== doc.providerEmail) {
      return res.status(403).json({ message: "Forbidden: not owner" });
    }

    const updatable = ["name", "category", "price", "description", "image"];
    const updates = {};
    updatable.forEach((k) => {
      if (k in req.body) updates[k] = req.body[k];
    });
    if (updates.name) updates.slug = await uniqueSlugForUpdate(updates.name, req.params.id);

    const updated = await Service.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// Delete (owner-only)
app.delete("/services/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Service not found" });

    const requester = (VERIFY_TOKEN ? tokenEmail : (req.query.providerEmail || req.body.providerEmail || "")).toLowerCase();
    if (VERIFY_TOKEN && requester !== doc.providerEmail) {
      return res.status(403).json({ message: "Forbidden: not owner" });
    }

    await Service.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// Bookings
app.post("/bookings", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (VERIFY_TOKEN && !tokenEmail) return res.status(401).json({ message: "Unauthorized" });

    const { serviceId, bookingDate, price } = req.body;
    if (!serviceId || !bookingDate || price == null) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const svc = await Service.findById(serviceId);
    if (!svc) return res.status(404).json({ message: "Service not found" });
    if (VERIFY_TOKEN && svc.providerEmail === tokenEmail) {
      return res.status(403).json({ message: "You cannot book your own service" });
    }

    const b = await Booking.create({
      userEmail: VERIFY_TOKEN ? tokenEmail : (req.body.userEmail || "").toLowerCase(),
      serviceId,
      bookingDate: new Date(bookingDate),
      price: Number(price),
    });
    res.status(201).json(b);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: "Already booked this date" });
    res.status(500).json({ message: e.message });
  }
});

app.get("/bookings", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const queryEmail = String(req.query.userEmail || "").toLowerCase();
    if (VERIFY_TOKEN && (!queryEmail || queryEmail !== tokenEmail)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const items = await Booking.find({ userEmail: VERIFY_TOKEN ? tokenEmail : queryEmail })
      .sort({ createdAt: -1 })
      .populate("serviceId", "name image providerName providerEmail price");

    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete("/bookings/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ message: "Booking not found" });
    if (VERIFY_TOKEN && b.userEmail !== tokenEmail) {
      return res.status(403).json({ message: "Forbidden" });
    }
    await Booking.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// Reviews (booked users only)
app.post("/services/:id/reviews", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    if (VERIFY_TOKEN && !tokenEmail) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { rating, comment } = req.body;
    if (!rating) return res.status(400).json({ message: "rating required" });

    const userEmail = VERIFY_TOKEN ? tokenEmail : (req.body.userEmail || "").toLowerCase();

    const booked = await Booking.findOne({ userEmail, serviceId: id });
    if (!booked) return res.status(403).json({ message: "Only booked users can review" });

    const svc = await Service.findById(id);
    if (!svc) return res.status(404).json({ message: "Service not found" });

    const idx = svc.reviews.findIndex((r) => r.userEmail === userEmail);
    if (idx >= 0) {
      svc.reviews[idx].rating = Number(rating);
      svc.reviews[idx].comment = comment || svc.reviews[idx].comment;
      svc.reviews[idx].date = new Date();
    } else {
      svc.reviews.push({ userEmail, rating: Number(rating), comment: comment || "" });
    }
    const sum = svc.reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    svc.ratingAvg = svc.reviews.length ? Number((sum / svc.reviews.length).toFixed(2)) : 0;

    await svc.save();
    res.status(201).json({ ok: true, ratingAvg: svc.ratingAvg, reviews: svc.reviews });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Favorites
app.post("/favorites", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const userEmail = VERIFY_TOKEN ? tokenEmail : (req.body.userEmail || "").toLowerCase();
    const { serviceId } = req.body;
    if (!serviceId) return res.status(400).json({ message: "serviceId required" });

    const fav = await Favorite.findOneAndUpdate(
      { userEmail, serviceId },
      { $setOnInsert: { userEmail, serviceId } },
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
    const userEmail = VERIFY_TOKEN ? tokenEmail : (req.query.userEmail || "").toLowerCase();
    const items = await Favorite.find({ userEmail }).populate("serviceId");
    res.json({ items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete("/favorites/:id", verifyAuth, async (req, res) => {
  try {
    const tokenEmail = (req.user?.email || "").toLowerCase();
    const doc = await Favorite.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Favorite not found" });
    if (VERIFY_TOKEN && doc.userEmail !== tokenEmail) return res.status(403).json({ message: "Forbidden" });
    await Favorite.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// ---------------- Global Error Handler ----------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

// ---------------- Export serverless handler ----------------
export default serverless(app);

// ---------------- Local Dev (optional) ----------------
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