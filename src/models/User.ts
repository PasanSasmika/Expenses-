import mongoose, { Schema, type InferSchemaType } from "mongoose";

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

export type UserDocument = InferSchemaType<typeof userSchema>;
export const User = mongoose.model("User", userSchema);
