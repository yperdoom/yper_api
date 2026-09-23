import mongoose from 'mongoose';

export const MEAL_TYPES = [
  'breakfast', 'morning_snack', 'lunch',
  'afternoon_snack', 'dinner', 'supper',
];

const MealItemSchema = new mongoose.Schema(
  {
    food: { type: mongoose.Schema.Types.ObjectId, ref: 'Food', required: true },
    // Na mesma unidade do servingUnit do alimento.
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const MealSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true, default: Date.now },
    type: { type: String, enum: MEAL_TYPES, required: true },
    items: { type: [MealItemSchema], default: [] },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

MealSchema.index({ user: 1, date: -1 });

export default mongoose.models.Meal || mongoose.model('Meal', MealSchema);
