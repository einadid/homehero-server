// routes/bookings.routes.js
import express from "express";
import Booking from "../models/Booking.js";
import Service from "../../models/Service.js";

const router = express.Router();

// Create booking
router.post("/", async (req, res) => {
  try {
    const { userEmail, serviceId, bookingDate, price } = req.body;
    if (!userEmail || !serviceId || !bookingDate || price == null) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ message: "Service not found" });

    // Restriction: cannot book own service
    if (service.providerEmail.toLowerCase() === userEmail.toLowerCase()) {
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

// Get bookings for a user
router.get("/", async (req, res) => {
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

// Cancel (delete) a booking
router.delete("/:id", async (req, res) => {
  try {
    const { userEmail } = req.query;
    const b = await Booking.findById(req.params.id);
    if (!b) return res.status(404).json({ message: "Booking not found" });

    // Ensure only owner can delete
    if (userEmail && b.userEmail !== userEmail.toLowerCase()) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await Booking.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;