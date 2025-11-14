import { Schema, model } from "mongoose";
const ReviewSchema = new Schema({
userEmail: { type: String, required: true, lowercase: true, trim: true },
rating: { type: Number, min: 1, max: 5 },
comment: { type: String, trim: true },
date: { type: Date, default: Date.now },
});

const ServiceSchema = new Schema(
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

export default model("Service", ServiceSchema);