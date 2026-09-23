import mongoose from 'mongoose';

const FoodSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    brand: { type: String, default: '', trim: true },

    // Os macros abaixo valem para uma porcao de servingSize servingUnit.
    servingSize: { type: Number, required: true, min: 0.01, default: 100 },
    servingUnit: { type: String, enum: ['g', 'ml', 'un'], default: 'g' },

    calories: { type: Number, default: 0, min: 0 },
    protein: { type: Number, default: 0, min: 0 },
    carbs: { type: Number, default: 0, min: 0 },
    fat: { type: Number, default: 0, min: 0 },
    fiber: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

FoodSchema.index({ user: 1, name: 1 });

export default mongoose.models.Food || mongoose.model('Food', FoodSchema);
