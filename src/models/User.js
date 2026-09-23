import mongoose from 'mongoose';

export const APPS = ['helake', 'movix', 'yper'];

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    apps: {
      type: [{ type: String, enum: APPS }],
      default: () => [...APPS],
    },
  },
  { timestamps: true }
);

export default mongoose.models.User || mongoose.model('User', UserSchema);
