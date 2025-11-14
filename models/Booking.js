// models/Booking.js
import { Schema, model } from "mongoose";

const BookingSchema = new Schema(
  {
    userEmail: { type: String, required: true, lowercase: true, trim: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    bookingDate: { type: Date, required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

export default model("Booking", BookingSchema);