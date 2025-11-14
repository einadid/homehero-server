// routes/services.routes.js
import express from "express";
import Service from "../models/Service.js";

const router = express.Router();

// Create service
router.post("/", async (req, res) => {
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

// List services (with filters + pagination)
router.get("/", async (req, res) => {
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

// Get single service
router.get("/:id", async (req, res) => {
  try {
    const item = await Service.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Service not found" });
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: "Invalid id" });
  }
});

// Update service (owner-only by email check)
router.patch("/:id", async (req, res) => {
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

// Delete service (owner-only by email check)
router.delete("/:id", async (req, res) => {
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

export default router;